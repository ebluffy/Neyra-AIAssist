"""Tests for Deepgram TTS provider with mocked HTTP."""
import asyncio
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
    assert request.headers["Authorization"].startswith("Token ")
    assert request.headers["Content-Type"] == "application/json"
    
    # Verify body
    import json
    body = json.loads(request.content.decode())
    assert "text" in body
    
    # Return fake PCM data (100ms of silence at 24kHz)
    pcm_data = make_pcm_16bit_mono(100, 24000)
    
    return httpx.Response(200, content=pcm_data)


@pytest.mark.asyncio
async def test_synthesize_success():
    """Test successful synthesis with correct URL, headers, and body."""
    transport = httpx.MockTransport(mock_handler_success)
    
    audio = await synthesize_to_wav_bytes(
        "Hello world",
        api_key="test-api-key",
        model="flux-polina-ru",
        expressivity=0,
        sample_rate=24000,
        transport=transport,
    )
    
    assert len(audio) > 44  # WAV header + data
    assert audio[:4] == b"RIFF"
    assert audio[8:12] == b"WAVE"


@pytest.mark.asyncio
async def test_wav_header_correctness():
    """Test that WAV header has correct length (not bogus placeholder)."""
    transport = httpx.MockTransport(mock_handler_success)
    
    audio = await synthesize_to_wav_bytes(
        "Test",
        api_key="test-key",
        transport=transport,
    )
    
    # Parse and verify the header
    meta = parse_wav_header(audio)
    assert meta["channels"] == 1
    assert meta["sample_width"] == 2  # 16-bit
    assert meta["framerate"] == 24000
    
    # Verify RIFF chunk size matches actual file size
    riff_size = struct.unpack("<I", audio[4:8])[0]
    assert riff_size == len(audio) - 8


@pytest.mark.asyncio
async def test_missing_api_key():
    """Test that missing API key raises ValueError."""
    with pytest.raises(ValueError, match="пустой api_key"):
        await synthesize_to_wav_bytes("Test", api_key="")


@pytest.mark.asyncio
async def test_http_400_error():
    """Test HTTP 400 error with err_code parsing."""
    def mock_error(request: httpx.Request) -> httpx.Response:
        import json
        return httpx.Response(
            400,
            content=json.dumps({"err_code": "invalid_text", "message": "Text is invalid"}),
        )
    
    transport = httpx.MockTransport(mock_error)
    
    with pytest.raises(RuntimeError, match=r"Deepgram TTS HTTP 400.*err_code=invalid_text"):
        await synthesize_to_wav_bytes("Test", api_key="test-key", transport=transport)


@pytest.mark.asyncio
async def test_url_and_query_params():
    """Test that URL and query parameters are correct."""
    def mock_verify_url(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        assert "api.deepgram.com/v2/speak" in url_str
        assert "model=flux-polina-ru" in url_str
        assert "expressivity=0" in url_str
        assert "encoding=linear16" in url_str
        assert "container=none" in url_str
        assert "sample_rate=24000" in url_str
        return httpx.Response(200, content=make_pcm_16bit_mono())
    
    transport = httpx.MockTransport(mock_verify_url)
    
    await synthesize_to_wav_bytes(
        "Test",
        api_key="test-key",
        transport=transport,
    )


@pytest.mark.asyncio
async def test_http_500_error():
    """Test HTTP 500 error without err_code."""
    def mock_error(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"Internal Server Error")
    
    transport = httpx.MockTransport(mock_error)
    
    with pytest.raises(RuntimeError, match=r"Deepgram TTS HTTP 500.*err_code=unknown"):
        await synthesize_to_wav_bytes("Test", api_key="test-key", transport=transport)
