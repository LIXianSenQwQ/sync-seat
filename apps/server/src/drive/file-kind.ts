const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".m3u8", ".mov", ".mkv", ".avi"]);
const SUBTITLE_EXTENSIONS = new Set([".vtt", ".srt"]);

export function getExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(name));
}

export function isSubtitleFile(name: string): boolean {
  return SUBTITLE_EXTENSIONS.has(getExtension(name));
}

export function subtitleFormat(name: string): "vtt" | "srt" | null {
  const ext = getExtension(name);
  if (ext === ".vtt") return "vtt";
  if (ext === ".srt") return "srt";
  return null;
}
