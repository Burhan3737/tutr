"""Voice for the tutor: speech to text (faster-whisper) and text to speech (Kokoro), both run locally on the CPU.

Nothing leaves the machine and nothing costs anything; the models load on first use (warm() starts that early)
and stay in memory. Whisper's model downloads into the Hugging Face cache the first time; Kokoro's two files
download into .cache/voice/. If the packages aren't installed the hub still runs, and status() says how to add them.

The browser sends the recording already decoded to 16 kHz mono 16-bit WAV, so no audio decoder (PyAV/ffmpeg)
is needed here.
"""
import io, math, os, threading, urllib.request, wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIR = HERE / ".cache" / "voice"
KOKORO_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin")
WHISPER_MODEL = "small.en"
# Measured on a Core Ultra 7 155H: 12 threads ran Kokoro at ~0.4x real time; the default (all 22) at ~0.8x.
TTS_THREADS = min(12, os.cpu_count() or 4)
VOICES = {      # Kokoro voice id -> label shown in the Talk tab
    "af_heart": "Heart (US, female)", "af_bella": "Bella (US, female)", "am_michael": "Michael (US, male)",
    "am_fenrir": "Fenrir (US, male)", "bf_emma": "Emma (UK, female)", "bm_george": "George (UK, male)",
}
DEFAULT_VOICE = "af_heart"

_lock = threading.Lock()            # loading
_tts_lock = threading.Lock()        # one synthesis at a time: they'd only compete for the same cores
_stt_lock = threading.Lock()
_m = {"stt": None, "tts": None, "loading": False, "error": None}


class VoiceError(Exception):
    """status: 400 for a bad recording or request, 503 when the models aren't available."""
    def __init__(self, msg, status=503):
        super().__init__(msg)
        self.status = status


def _download(name):
    DIR.mkdir(parents=True, exist_ok=True)
    dest = DIR / name
    if dest.is_file():
        return dest
    part = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(KOKORO_URL + name, timeout=60) as r, open(part, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(part, dest)
    return dest


def _load():
    with _lock:
        if _m["stt"] and _m["tts"]:
            _m["loading"] = False       # warm() may have set it just before another call finished loading
            return
        _m["loading"], _m["error"] = True, None
        try:
            try:
                import onnxruntime as ort
                from faster_whisper import WhisperModel
                from kokoro_onnx import Kokoro
            except ImportError as e:
                raise VoiceError(f"Voice needs two Python packages ({e.name} is missing). "
                                 "Run: python -m pip install faster-whisper kokoro-onnx") from e
            if not _m["tts"]:
                model, voices = (_download(n) for n in KOKORO_FILES)
                so = ort.SessionOptions()
                so.intra_op_num_threads = TTS_THREADS
                so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
                _m["tts"] = Kokoro.from_session(sess, str(voices))
            if not _m["stt"]:
                _m["stt"] = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        except VoiceError as e:
            _m["error"] = str(e)
            raise
        except Exception as e:
            _m["error"] = f"The voice models didn't load ({type(e).__name__}). The first start downloads them, so check the internet connection."
            raise VoiceError(_m["error"]) from e
        finally:
            _m["loading"] = False


def warm():
    """Start loading the models in the background (the Talk tab calls this when it opens)."""
    if not (_m["stt"] and _m["tts"]) and not _m["loading"]:
        _m["loading"], _m["error"] = True, None     # so status() right after shows the retry, not the old error

        def run():
            try:
                _load()
            except VoiceError:
                pass        # kept in _m["error"] for status()
        threading.Thread(target=run, daemon=True).start()


def status():
    return {"ready": bool(_m["stt"] and _m["tts"]), "loading": _m["loading"], "error": _m["error"],
            "voices": VOICES, "default_voice": DEFAULT_VOICE}


def transcribe(wav_bytes, hint=""):
    """A 16 kHz mono 16-bit WAV -> text. hint: words likely to come up (deck and slide titles), so course
    terms are heard correctly."""
    import numpy as np
    try:
        with wave.open(io.BytesIO(wav_bytes)) as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1 or w.getframerate() <= 0:
                raise VoiceError("The recording came in an unexpected format. Reload the page and try again.", 400)
            rate, frames = w.getframerate(), w.readframes(w.getnframes())
    except (wave.Error, EOFError) as e:
        raise VoiceError("The recording was empty or damaged. Try again.", 400) from e
    try:
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768
    except ValueError as e:     # an odd number of bytes: a truncated recording
        raise VoiceError("The recording was empty or damaged. Try again.", 400) from e
    if rate != 16000:       # the browser resamples already; this is only a fallback
        audio = np.interp(np.arange(0, len(audio), rate / 16000), np.arange(len(audio)), audio).astype(np.float32)
    if len(audio) < 16000 * 0.3:
        return ""
    _load()
    with _stt_lock:
        segs, _ = _m["stt"].transcribe(audio, language="en", beam_size=1, vad_filter=True,
                                       initial_prompt=hint or None, condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segs).strip()


def speak(text, voice=DEFAULT_VOICE, speed=1.0):
    """Text -> WAV bytes (mono, 16-bit)."""
    _load()
    import numpy as np
    voice = voice if voice in VOICES else DEFAULT_VOICE
    try:
        speed = float(speed or 1)
    except (TypeError, ValueError):
        speed = 1.0
    speed = min(1.6, max(0.6, speed)) if math.isfinite(speed) else 1.0
    with _tts_lock:
        samples, rate = _m["tts"].create(text, voice=voice, speed=speed, lang="en-us")
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()
