import argparse
import gc
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
from pathlib import Path


os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def emit(event, message="", content=""):
    print(json.dumps({"event": event, "message": message, "content": content}, ensure_ascii=False), flush=True)


def fail(message):
    emit("error", message)
    sys.exit(1)


def import_deps(download_only=False, engine="faster_whisper"):
    try:
        import yt_dlp
    except Exception:
        fail("yt-dlp is missing in the local ASR environment")
    if download_only:
        return yt_dlp, None
    if engine == "faster_whisper":
        try:
            from faster_whisper import WhisperModel
        except Exception:
            fail("faster-whisper is missing in the local ASR environment")
        return yt_dlp, WhisperModel
    try:
        from funasr import AutoModel
    except Exception:
        fail("funasr is missing in the local ASR environment. Install it or switch local ASR engine to faster-whisper.")
    return yt_dlp, AutoModel


class ProgressHook:
    def __call__(self, data):
        status = data.get("status")
        if status == "downloading":
            downloaded = data.get("downloaded_bytes") or 0
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            if total:
                emit("progress", f"Downloading audio: {downloaded * 100 / total:.1f}%")
            else:
                emit("progress", "Downloading audio...")
        elif status == "finished":
            emit("progress", "Audio download finished")


def download_audio(yt_dlp, video_url, work_dir):
    target_dir = work_dir / "audio"
    target_dir.mkdir(parents=True, exist_ok=True)

    for stale in target_dir.glob("*.part"):
        stale.unlink(missing_ok=True)

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
    }
    cookie = os.environ.get("BILIBILI_COOKIE", "").strip()
    if cookie:
        headers["Cookie"] = cookie

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(target_dir / "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "http_headers": headers,
        "progress_hooks": [ProgressHook()],
    }
    emit("progress", "Connecting to Bilibili and downloading audio...")
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([video_url])

    files = [p for p in target_dir.iterdir() if p.is_file() and not p.name.endswith(".part") and p.stat().st_size > 0]
    if not files:
        fail("No audio file was downloaded. If this video requires login, configure BILIBILI_COOKIE and retry.")
    files.sort(key=lambda p: p.stat().st_size, reverse=True)
    return files[0]


def load_model(WhisperModel, model_name, device):
    if device == "auto":
        try:
            emit("progress", f"Loading faster-whisper model: {model_name} / cuda")
            return WhisperModel(model_name, device="cuda", compute_type="float16")
        except Exception as exc:
            emit("progress", f"CUDA failed, switching to CPU: {exc}")
            emit("progress", f"Loading faster-whisper model: {model_name} / cpu")
            return WhisperModel(model_name, device="cpu", compute_type="int8")
    emit("progress", f"Loading faster-whisper model: {model_name} / {device}")
    compute_type = "float16" if device == "cuda" else "int8"
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe_faster_whisper(WhisperModel, audio_path, model_name, device, language):
    model = load_model(WhisperModel, model_name, device)
    emit("progress", "Starting speech-to-text...")
    lang = None if language == "auto" else language
    segments, info = model.transcribe(
        str(audio_path),
        language=lang,
        vad_filter=True,
        beam_size=5,
        word_timestamps=False,
    )
    lines = []
    duration = getattr(info, "duration", 0) or 0
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        lines.append(f"[{seg.start:.1f}-{seg.end:.1f}] {text}")
        if duration:
            emit("progress", f"Transcribing: {seg.end / duration * 100:.1f}% / {seg.end / 60:.1f} min")
        else:
            emit("progress", f"Transcribed to {seg.end / 60:.1f} min")
    return "\n".join(lines).strip()


def load_funasr_model(AutoModel, engine, model_name, device):
    if not model_name:
        model_name = "iic/SenseVoiceSmall" if engine == "sensevoice" else "paraformer-zh"
    resolved_device = resolve_torch_device(device)
    emit("progress", f"Loading {engine} model: {model_name} / {resolved_device}")
    kwargs = {"model": model_name, "disable_update": True}
    if engine == "sensevoice":
        kwargs["trust_remote_code"] = True
    if resolved_device == "cuda":
        kwargs["device"] = "cuda:0"
    elif resolved_device == "cpu":
        kwargs["device"] = "cpu"
    return AutoModel(**kwargs)


def load_vad_model(AutoModel, device):
    emit("progress", "Loading VAD model: fsmn-vad")
    kwargs = {"model": "fsmn-vad", "model_revision": "v2.0.4", "disable_update": True, "device": "cpu"}
    return AutoModel(**kwargs)


def transcribe_funasr(AutoModel, audio_path, model_name, device, engine, language, work_dir, vad_mode, max_segment_seconds):
    audio_path = ensure_funasr_audio(audio_path, work_dir)
    if vad_mode != "off":
        content = transcribe_funasr_with_vad(
            AutoModel,
            audio_path,
            model_name,
            device,
            engine,
            language,
            work_dir,
            max_segment_seconds,
        )
        if content:
            return content
        emit("progress", "VAD returned no usable text, falling back to full-file ASR...")

    model = load_funasr_model(AutoModel, engine, model_name, device)
    emit("progress", "Starting local FunASR/SenseVoice transcription...")
    kwargs = {
        "input": str(audio_path),
        "batch_size_s": 300,
    }
    if engine == "sensevoice":
        kwargs.update({"language": "auto" if language == "auto" else language, "use_itn": True})
    result = model.generate(**kwargs)
    return format_funasr_result(result)


def transcribe_funasr_with_vad(AutoModel, audio_path, model_name, device, engine, language, work_dir, max_segment_seconds):
    vad_model = load_vad_model(AutoModel, device)
    emit("progress", "Detecting speech segments with VAD...")
    vad_result = vad_model.generate(input=str(audio_path))
    raw_segments = extract_vad_segments(vad_result)
    segments = build_chunks(raw_segments, max_segment_seconds=max_segment_seconds)
    if not segments:
        return ""
    emit("progress", f"VAD found {len(raw_segments)} speech ranges, built {len(segments)} ASR chunks")

    del vad_model
    gc.collect()
    try_empty_cuda_cache()

    model = load_funasr_model(AutoModel, engine, model_name, device)
    chunk_dir = work_dir / "vad_chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    lines = []
    for index, (start_ms, end_ms) in enumerate(segments, start=1):
        chunk_path = chunk_dir / f"chunk-{index:04d}-{start_ms}-{end_ms}.wav"
        extract_audio_chunk(audio_path, chunk_path, start_ms, end_ms)
        emit("progress", f"Transcribing VAD chunk {index}/{len(segments)} [{start_ms / 1000:.1f}-{end_ms / 1000:.1f}]...")
        kwargs = {
            "input": str(chunk_path),
            "batch_size_s": min(max_segment_seconds, 60),
        }
        if engine == "sensevoice":
            kwargs.update({"language": "auto" if language == "auto" else language, "use_itn": True})
        result = model.generate(**kwargs)
        chunk_lines = format_funasr_result(result, offset_ms=start_ms, fallback_range=(start_ms, end_ms))
        if chunk_lines:
            lines.append(chunk_lines)
    return "\n".join(lines).strip()


def extract_vad_segments(result):
    items = result if isinstance(result, list) else [result]
    segments = []
    for item in items:
        if not isinstance(item, dict):
            continue
        for value in item.get("value") or item.get("segments") or []:
            if not isinstance(value, (list, tuple)) or len(value) < 2:
                continue
            try:
                start = int(float(value[0]))
                end = int(float(value[1]))
            except (TypeError, ValueError):
                continue
            if end > start:
                segments.append((start, end))
    return sorted(segments)


def build_chunks(raw_segments, max_segment_seconds=30, pad_ms=200, merge_gap_ms=800, min_segment_ms=400):
    if not raw_segments:
        return []
    padded = []
    for start, end in raw_segments:
        if end - start < min_segment_ms:
            continue
        padded.append((max(0, start - pad_ms), end + pad_ms))
    if not padded:
        return []

    merged = []
    cur_start, cur_end = padded[0]
    max_ms = max(5000, int(max_segment_seconds * 1000))
    for start, end in padded[1:]:
        if start - cur_end <= merge_gap_ms and end - cur_start <= max_ms:
            cur_end = max(cur_end, end)
            continue
        merged.extend(split_long_segment(cur_start, cur_end, max_ms))
        cur_start, cur_end = start, end
    merged.extend(split_long_segment(cur_start, cur_end, max_ms))
    return normalize_chunks(merged)


def split_long_segment(start_ms, end_ms, max_ms):
    if end_ms - start_ms <= max_ms:
        return [(start_ms, end_ms)]
    chunks = []
    cursor = start_ms
    while cursor < end_ms:
        chunk_end = min(end_ms, cursor + max_ms)
        if chunk_end - cursor >= 1000:
            chunks.append((cursor, chunk_end))
        cursor = chunk_end
    return chunks


def normalize_chunks(chunks):
    clean = []
    last_end = 0
    for start, end in sorted(chunks):
        start = max(start, last_end)
        if end - start < 500:
            continue
        clean.append((start, end))
        last_end = end
    return clean


def extract_audio_chunk(audio_path, output_path, start_ms, end_ms):
    ffmpeg = find_executable("ffmpeg")
    duration = max(0.2, (end_ms - start_ms) / 1000)
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_ms / 1000:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(audio_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(output_path),
    ]
    subprocess.run(command, check=True)


def ensure_funasr_audio(audio_path, work_dir):
    source = Path(audio_path)
    if source.suffix.lower() == ".wav":
        return source
    target_dir = Path(work_dir) / "prepared_audio"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{source.stem}.16k.wav"
    if target.exists() and target.stat().st_size > 0 and target.stat().st_mtime >= source.stat().st_mtime:
        emit("progress", f"Using prepared WAV audio: {target}")
        return target
    ffmpeg = find_executable("ffmpeg")
    if not Path(ffmpeg).exists() and shutil.which(ffmpeg) is None:
        fail("ffmpeg is required to prepare audio for FunASR/SenseVoice, but it was not found")
    emit("progress", f"Preparing 16k WAV audio for FunASR/SenseVoice: {target}")
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(target),
    ]
    subprocess.run(command, check=True)
    return target


def find_executable(name):
    found = shutil.which(name)
    if found:
        return found
    exe = f"{name}.exe" if os.name == "nt" else name
    root = Path(__file__).resolve().parents[1]
    candidates = [
        root / "tools" / "ffmpeg" / "bin" / exe,
        root / "node_modules" / "@remotion" / "compositor-win32-x64-msvc" / exe,
        root.parent / "bilibili-study-notes-remotion" / "node_modules" / "@remotion" / "compositor-win32-x64-msvc" / exe,
        root.parent / "B站视频总结工具" / "node_modules" / "@remotion" / "compositor-win32-x64-msvc" / exe,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return name


def try_empty_cuda_cache():
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def resolve_torch_device(device):
    if device in ("cuda", "cpu"):
        return device
    if device != "auto":
        return device
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def format_funasr_result(result, offset_ms=0, fallback_range=None):
    items = result if isinstance(result, list) else [result]
    lines = []
    fallback_text = []
    for item in items:
        if not isinstance(item, dict):
            continue
        sentence_info = item.get("sentence_info") or item.get("sentences") or []
        for sentence in sentence_info:
            text = clean_asr_text(sentence.get("text") or sentence.get("sentence") or "")
            if not text:
                continue
            start = (offset_ms + float(sentence.get("start") or sentence.get("timestamp", [0, 0])[0] or 0)) / 1000
            end = (offset_ms + float(sentence.get("end") or sentence.get("timestamp", [0, 0])[-1] or 0)) / 1000
            lines.append(f"[{start:.1f}-{end:.1f}] {text}")
        text = clean_asr_text(item.get("text") or "")
        if text:
            fallback_text.append(text)
    if lines:
        return "\n".join(lines).strip()
    if fallback_range and fallback_text:
        start_ms, end_ms = fallback_range
        return f"[{start_ms / 1000:.1f}-{end_ms / 1000:.1f}] {' '.join(fallback_text).strip()}"
    return "\n".join(fallback_text).strip()


def clean_asr_text(text):
    return re.sub(r"<\|[^|]+?\|>", "", str(text or "")).strip()


def transcribe(asr_class, audio_path, model_name, device, engine, language, work_dir, vad_mode, max_segment_seconds):
    if engine == "faster_whisper":
        return transcribe_faster_whisper(asr_class, audio_path, model_name, device, language)
    return transcribe_funasr(asr_class, audio_path, model_name, device, engine, language, work_dir, vad_mode, max_segment_seconds)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--audio", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--engine", default="faster_whisper", choices=["faster_whisper", "funasr", "sensevoice"])
    parser.add_argument("--language", default="auto")
    parser.add_argument("--vad", default="auto", choices=["auto", "off"])
    parser.add_argument("--max-segment-seconds", type=int, default=30)
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()

    try:
        yt_dlp, asr_class = import_deps(args.download_only, args.engine)
        work_dir = Path(args.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        if args.audio:
            audio_path = Path(args.audio)
            if not audio_path.exists():
                fail(f"Audio file does not exist: {audio_path}")
            emit("progress", f"Using cached audio: {audio_path}")
        else:
            audio_path = download_audio(yt_dlp, args.url, work_dir)
        if args.download_only:
            emit("done", "Audio download finished", str(audio_path))
            return
        content = transcribe(
            asr_class,
            audio_path,
            args.model,
            args.device,
            args.engine,
            args.language,
            work_dir,
            args.vad,
            args.max_segment_seconds,
        )
        if not content:
            fail("Transcription finished, but no text was recognized")
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(content, encoding="utf-8")
        emit("done", "Transcription finished", content)
    except SystemExit:
        raise
    except Exception as exc:
        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        fail(detail)


if __name__ == "__main__":
    main()
