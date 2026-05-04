import axios, { type AxiosInstance } from 'axios';

export type SharePermission = 'view' | 'edit' | 'admin';

export interface Share {
  id: string;
  shareCode: string;
  permission: SharePermission;
  title: string;
  isActive: boolean;
  listId: string;
  ownerId: number;
  createdAt: string;
  list?: {
    id: string;
    title: string;
  };
}

export interface CreateShareInput {
  listId: string;
  permission?: SharePermission;
  title?: string;
}

export interface UpdateShareInput {
  permission?: SharePermission;
  isActive?: boolean;
}

export interface ShareTask {
  id: string;
  title: string;
  isCompleted: boolean;
  isImportant: boolean;
  dueDate: string | null;
  myDay: boolean;
  createdAt: string;
}

export interface ShareViewData {
  list: { id: string; title: string };
  tasks: ShareTask[];
  permission: string;
}

function getApiBaseUrl(): string {
  return localStorage.getItem('orbit_api_url') || 'http://localhost:3001/api';
}

function getToken(): string | null {
  return localStorage.getItem('unitodo_token');
}

function createShareApi(): AxiosInstance {
  const api = axios.create({
    baseURL: getApiBaseUrl(),
    headers: { 'Content-Type': 'application/json' },
    withCredentials: false,
  });
  api.interceptors.request.use((config) => {
    const token = getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  return api;
}

export async function createShare(input: CreateShareInput): Promise<Share> {
  const api = createShareApi();
  const { data } = await api.post<Share>('/shares', input);
  return data;
}

export async function getMyShares(): Promise<Share[]> {
  const api = createShareApi();
  const { data } = await api.get<Share[]>('/shares');
  return data;
}

export async function updateShare(id: string, input: UpdateShareInput): Promise<Share> {
  const api = createShareApi();
  const { data } = await api.patch<Share>(`/shares/${id}`, input);
  return data;
}

export async function deleteShare(id: string): Promise<void> {
  const api = createShareApi();
  await api.delete(`/shares/${id}`);
}

export async function resolveSharePermission(shareCode: string): Promise<string> {
  const api = createShareApi();
  const { data } = await api.get<string>(`/shares/resolve/${shareCode}`);
  return data;
}

export async function getSharedListTasks(
  shareCode: string,
): Promise<{ list: { id: string; title: string }; permission: string }> {
  const api = createShareApi();
  const { data } = await api.get<{ list: { id: string; title: string }; permission: string }>(
    `/shares/${shareCode}/tasks`,
  );
  return data;
}

export async function getShareView(shareCode: string): Promise<ShareViewData> {
  const api = createShareApi();
  const { data } = await api.get<ShareViewData>(`/shares/view/${shareCode}`);
  return data;
}

export function buildShareUrl(shareCode: string): string {
  const baseUrl = window.location.origin;
  return `${baseUrl}/share/${shareCode}`;
}
