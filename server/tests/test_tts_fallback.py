"""Tests for TTS dispatcher with fallback logic."""
import pytest
from core.voice import tts


@pytest.mark.asyncio
async def test_fallback_deepgram_to_yandex_missing_key():
    """When Deepgram key is missing, should fall back to Yandex."""
    import os
    from unittest.mock import patch
    
    config = {
        "voice": {
            "tts": {
                "enabled": True,
                "cloud": {
                    "provider": "deepgram",
                    "yandex": {
                        "api_key": "fake_yandex_key",
                        "folder_id": "fake_folder",
                    }
                }
            }
        }
    }
    
    with patch.dict(os.environ, {}, clear=True):
        # Mock yandex synthesize to return test data
        with patch("core.voice.yandex_tts.synthesize_to_wav_bytes") as mock_yandex:
            mock_yandex.return_value = b"YANDEX_AUDIO_DATA"
            
            result = await tts.synthesize_from_config("test", config)
            
            # Should have fallen back to yandex
            assert result == b"YANDEX_AUDIO_DATA"
            mock_yandex.assert_called_once()


@pytest.mark.asyncio
async def test_fallback_deepgram_to_yandex_on_error():
    """When Deepgram fails, should fall back to Yandex."""
    import os
    from unittest.mock import patch
    
    config = {
        "voice": {
            "tts": {
                "enabled": True,
                "cloud": {
                    "provider": "deepgram",
                    "deepgram": {"api_key": "fake_dg_key"},
                    "yandex": {
                        "api_key": "fake_yandex_key",
                        "folder_id": "fake_folder",
                    }
                }
            }
        }
    }
    
    with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "fake_dg_key"}):
        # Mock deepgram to raise error
        with patch("core.voice.deepgram_tts.synthesize_to_wav_bytes") as mock_deepgram:
            mock_deepgram.side_effect = Exception("Network error")
            
            # Mock yandex to succeed
            with patch("core.voice.yandex_tts.synthesize_to_wav_bytes") as mock_yandex:
                mock_yandex.return_value = b"YANDEX_AUDIO_DATA"
                
                result = await tts.synthesize_from_config("test", config)
                
                # Should have fallen back to yandex
                assert result == b"YANDEX_AUDIO_DATA"
                mock_deepgram.assert_called_once()
                mock_yandex.assert_called_once()
