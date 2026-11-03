"""Tests for Deepgram TTS provider with mocked HTTP."""
import asyncio
import json
import struct
import wave
from io import BytesIO

import httpx
import pytest

from core.voice.deepgram_tts import synthesize_to_wav_bytes


def make_pcm_16bit_mono(duration_ms: int = 100, sample_rate: int = 24000) -> bytes:
    """Generate dummy PCM 16-bit mono audio data."""
    num_samples = int((duration_ms / 1000.0) * sample_rate)
    return b"\x00\x01" * num_samples


def parse_wav_header(wav_bytes: bytes) -> dict:
    """Parse WAV header and return metadata."""
    with BytesIO(wav_bytes) as f:
        with wave.open(f, "rb") as wav:
            return {
                "channels": wav.getnchannels(),
                "sample_width": wav.getsampwidth(),
                "framerate": wav.getframerate(),
                "n_frames": wav.getnframes(),
            }


def mock_handler_success(request: httpx.Request) -> httpx.Response:
    """Mock successful Deepgram response."""
    # Verify headers
    assert request.headers["Authorization"] in {"Token test-api-key", "Token test-key"}
    assert request.headers["Content-Type"] == "application/json"

    # Verify body
    import json
    body = json.loads(request.content.decode())
    assert "text" in body

    # Return fake PCM data (100ms of silence at 24kHz)
    pcm_data = make_pcm_16bit_mono(100, 24000)

    return httpx.Response(200, content=pcm_data)


def test_synthesize_success():
    """Test successful synthesis with correct URL, headers, and body."""
    transport = httpx.MockTransport(mock_handler_success)

    audio = asyncio.run(synthesize_to_wav_bytes(
        "Hello world",
        api_key="test-api-key",
        model="flux-polina-ru",
        expressivity=0,
        sample_rate=24000,
        transport=transport,
    ))

    assert len(audio) > 44  # WAV header + data
    assert audio[:4] == b"RIFF"
    assert audio[8:12] == b"WAVE"


def test_wav_header_correctness():
    """Test that WAV header has correct length (not bogus placeholder)."""
    transport = httpx.MockTransport(mock_handler_success)

    audio = asyncio.run(synthesize_to_wav_bytes(
        "Test",
        api_key="test-key",
        transport=transport,
    ))

    # Parse and verify the header
    meta = parse_wav_header(audio)
    assert meta["channels"] == 1
    assert meta["sample_width"] == 2  # 16-bit
    assert meta["framerate"] == 24000

    # Verify RIFF chunk size matches actual file size
    riff_size = struct.unpack("<I", audio[4:8])[0]
    assert riff_size == len(audio) - 8


def test_missing_api_key():
    """Test that missing API key raises ValueError."""
    with pytest.raises(ValueError, match="DEEPGRAM_API_KEY is not set"):
        asyncio.run(synthesize_to_wav_bytes("Test", api_key=""))


def test_http_400_error():
    """Test HTTP 400 error with err_code parsing."""
    def mock_error(request: httpx.Request) -> httpx.Response:
        import json
        return httpx.Response(
            400,
            content=json.dumps({"err_code": "invalid_text", "message": "Text is invalid"}),
        )

    transport = httpx.MockTransport(mock_error)

    with pytest.raises(RuntimeError, match=r"Deepgram TTS HTTP 400.*err_code=invalid_text"):
        asyncio.run(synthesize_to_wav_bytes("Test", api_key="test-key", transport=transport))


def test_url_and_query_params():
    """Test that URL and query parameters are correct."""
    def mock_verify_url(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        assert "api.deepgram.com/v2/speak" in url_str
        assert "model=flux-polina-ru" in url_str
        assert request.url.params["expressivity"] == "0"
        assert "encoding=linear16" in url_str
        assert "container=none" in url_str
        assert "sample_rate=24000" in url_str
        return httpx.Response(200, content=make_pcm_16bit_mono())

    transport = httpx.MockTransport(mock_verify_url)

    asyncio.run(synthesize_to_wav_bytes(
        "Test",
        api_key="test-key",
        transport=transport,
    ))


def test_http_500_error():
    """Test HTTP 500 error without err_code."""
    def mock_error(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"Internal Server Error")

    transport = httpx.MockTransport(mock_error)

    with pytest.raises(RuntimeError, match=r"^Deepgram TTS HTTP 500$"):
        asyncio.run(synthesize_to_wav_bytes("Test", api_key="test-key", transport=transport))


@pytest.mark.parametrize("value", [0, 0.0, "0", -2, 2, 1.5, "0.5", 3, None, True, float("inf")])
def test_expressivity_integer_query(value, caplog):
    valid = type(value) in (int, float) and value in {-2, -1, 0, 1, 2} or value == "0"
    expected = str(int(value)) if valid else "0"

    def handler(request):
        assert request.url.params["expressivity"] == expected
        return httpx.Response(200, content=b"\x00\x00")

    asyncio.run(synthesize_to_wav_bytes("Private text", api_key="test-key", expressivity=value,
                                       transport=httpx.MockTransport(handler)))
    if not valid:
        assert "invalid expressivity" in caplog.text


def test_exact_request_and_wav_payload():
    pcm = b"\x01\x02" * 50

    def handler(request):
        assert request.method == "POST"
        assert request.url.host == "api.deepgram.com"
        assert request.url.path == "/v2/speak"
        assert dict(request.url.params) == {
            "model": "flux-polina-ru", "expressivity": "0", "encoding": "linear16",
            "container": "none", "sample_rate": "16000",
        }
        assert json.loads(request.content) == {"text": "Привет"}
        assert request.extensions["timeout"] == {"connect": 10, "read": 25, "write": 25, "pool": 25}
        return httpx.Response(200, content=pcm)

    audio = asyncio.run(synthesize_to_wav_bytes("Привет", api_key="test-key", sample_rate=16000,
                                              timeout=25, transport=httpx.MockTransport(handler)))
    assert audio[44:] == pcm
    assert struct.unpack("<I", audio[40:44])[0] == len(pcm)
    assert parse_wav_header(audio) == {
        "channels": 1, "sample_width": 2, "framerate": 16000, "n_frames": 50,
    }


@pytest.mark.parametrize("failure", ["timeout", "network", "empty", "long_code", "non_json", "json_list"])
def test_safe_failures(failure, caplog):
    private = "PRIVATE_REQUEST_TEXT_AND_KEY"

    def handler(request):
        assert request.extensions["timeout"]["connect"] == 3
        if failure == "timeout":
            raise httpx.ReadTimeout(private, request=request)
        if failure == "network":
            raise httpx.ConnectError(private, request=request)
        if failure == "empty":
            return httpx.Response(200, content=b"")
        if failure == "long_code":
            return httpx.Response(400, json={"err_code": "A" * 100, "message": private})
        if failure == "json_list":
            return httpx.Response(400, json=[private])
        return httpx.Response(500, content=private.encode())

    with pytest.raises((RuntimeError, ValueError)) as caught:
        asyncio.run(synthesize_to_wav_bytes(private, api_key=private, timeout=3,
                                           transport=httpx.MockTransport(handler)))
    assert private not in str(caught.value)
    assert private not in caplog.text
    assert caught.value.__cause__ is None
    if failure == "long_code":
        assert str(caught.value) == "Deepgram TTS HTTP 400 (err_code=" + "A" * 64 + ")"
    import traceback
    assert private not in "".join(traceback.format_exception(caught.value))


@pytest.mark.parametrize("code", ["private text", {"text": "private text"}])
def test_untrusted_error_code_is_not_echoed(code):
    transport = httpx.MockTransport(lambda r: httpx.Response(400, json={"err_code": code, "message": "private text"}))
    with pytest.raises(RuntimeError, match=r"^Deepgram TTS HTTP 400$"):
        asyncio.run(synthesize_to_wav_bytes("private text", api_key="secret", transport=transport))
