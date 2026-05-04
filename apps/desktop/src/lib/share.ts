import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

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
  api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
  return api;
}

export async function createShare(input: CreateShareInput): Promise<Share> {
  const api = createShareApi();
  const { data } = await api.post<{ success: boolean; data: Share }>('/shares', input);
  return data.data;
}

export async function getMyShares(): Promise<Share[]> {
  const api = createShareApi();
  const { data } = await api.get<{ success: boolean; data: Share[] }>('/shares');
  return data.data;
}

export async function updateShare(id: string, input: UpdateShareInput): Promise<Share> {
  const api = createShareApi();
  const { data } = await api.patch<{ success: boolean; data: Share }>(`/shares/${id}`, input);
  return data.data;
}

export async function deleteShare(id: string): Promise<void> {
  const api = createShareApi();
  await api.delete(`/shares/${id}`);
}

export function buildShareUrl(shareCode: string): string {
  return `https://orbit.app/share/${shareCode}`;
}
