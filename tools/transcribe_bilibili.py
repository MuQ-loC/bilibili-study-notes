import argparse
import json
import os
import sys
import traceback
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def emit(event, message="", content=""):
    print(json.dumps({"event": event, "message": message, "content": content}, ensure_ascii=False), flush=True)


def fail(message):
    emit("error", message)
    sys.exit(1)


def import_deps():
    try:
        import yt_dlp
    except Exception:
        fail("缺少 yt-dlp，请先安装本地 ASR 环境")
    try:
        from faster_whisper import WhisperModel
    except Exception:
        fail("缺少 faster-whisper，请先安装本地 ASR 环境")
    return yt_dlp, WhisperModel


class ProgressHook:
    def __call__(self, data):
        status = data.get("status")
        if status == "downloading":
            downloaded = data.get("downloaded_bytes") or 0
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            if total:
                emit("progress", f"正在下载音频：{downloaded * 100 / total:.1f}%")
            else:
                emit("progress", "正在下载音频...")
        elif status == "finished":
            emit("progress", "音频下载完成，准备转写...")


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
    emit("progress", "正在连接 B 站并下载音频...")
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([video_url])

    files = [p for p in target_dir.iterdir() if p.is_file() and not p.name.endswith(".part") and p.stat().st_size > 0]
    if not files:
        fail("没有下载到音频；如果这是登录/付费视频，请配置 BILIBILI_COOKIE 后重试")
    files.sort(key=lambda p: p.stat().st_size, reverse=True)
    return files[0]


def load_model(WhisperModel, model_name, device):
    if device == "auto":
        try:
            emit("progress", f"正在加载 faster-whisper 模型：{model_name} / cuda")
            return WhisperModel(model_name, device="cuda", compute_type="float16")
        except Exception as exc:
            emit("progress", f"CUDA 加载失败，切到 CPU：{exc}")
            emit("progress", f"正在加载 faster-whisper 模型：{model_name} / cpu")
            return WhisperModel(model_name, device="cpu", compute_type="int8")
    emit("progress", f"正在加载 faster-whisper 模型：{model_name} / {device}")
    compute_type = "float16" if device == "cuda" else "int8"
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe(WhisperModel, audio_path, model_name, device):
    model = load_model(WhisperModel, model_name, device)
    emit("progress", "开始语音转文字...")
    segments, info = model.transcribe(
        str(audio_path),
        language="zh",
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
            emit("progress", f"正在转写：{seg.end / duration * 100:.1f}% / {seg.end / 60:.1f} 分钟")
        else:
            emit("progress", f"正在转写到 {seg.end / 60:.1f} 分钟")
    return "\n".join(lines).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--audio", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    try:
        yt_dlp, WhisperModel = import_deps()
        work_dir = Path(args.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        if args.audio:
            audio_path = Path(args.audio)
            if not audio_path.exists():
                fail(f"音频文件不存在：{audio_path}")
            emit("progress", f"使用已下载音频：{audio_path}")
        else:
            audio_path = download_audio(yt_dlp, args.url, work_dir)
        content = transcribe(WhisperModel, audio_path, args.model, args.device)
        if not content:
            fail("转写完成，但没有识别到文字")
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(content, encoding="utf-8")
        emit("done", "转写完成", content)
    except SystemExit:
        raise
    except Exception as exc:
        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        fail(detail)


if __name__ == "__main__":
    main()
