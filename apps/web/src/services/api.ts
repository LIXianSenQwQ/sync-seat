import type { CreateRoomRequest, CreateRoomResponse, DriveEntry, IceServerConfig, JoinRoomRequest, RoomState } from "@sync-seat/shared";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {})
    },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "请求失败");
  }
  return response.json() as Promise<T>;
}

export const api = {
  listDrive(path: string): Promise<DriveEntry[]> {
    return request(`/api/drive/list?path=${encodeURIComponent(path)}`);
  },
  listSubtitles(videoPath: string): Promise<DriveEntry[]> {
    return request(`/api/drive/subtitles?videoPath=${encodeURIComponent(videoPath)}`);
  },
  createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
    return request("/api/rooms", {
      method: "POST",
      body: JSON.stringify(body)
    });
  },
  joinRoom(roomCode: string, body: JoinRoomRequest): Promise<RoomState> {
    return request(`/api/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },
  getRoom(roomCode: string): Promise<RoomState> {
    return request(`/api/rooms/${roomCode}`);
  },
  getIceServers(): Promise<IceServerConfig[]> {
    return request("/api/drive/ice-servers");
  }
};
