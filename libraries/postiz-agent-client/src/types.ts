export type PostizCredential = Readonly<{
  apiKey: string;
  apiUrl: string;
}>;

export type PostizHttpMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PostizMultipartPart = Readonly<{
  field: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}>;

export type PostizMultipartBody = Readonly<{
  kind: 'multipart';
  parts: readonly PostizMultipartPart[];
}>;

export type PostizTransportRequest = Readonly<{
  credential: PostizCredential;
  method: PostizHttpMethod;
  path: string;
  query?: Readonly<Record<string, string>>;
  body?: JsonValue | PostizMultipartBody;
  signal?: AbortSignal;
}>;

export type PostizTransportResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export interface PostizAgentTransport {
  request(request: PostizTransportRequest): Promise<PostizTransportResponse>;
}

export type IntegrationSummary = Readonly<{
  id: string;
  identifier: string;
  name: string;
  picture: string | null;
  disabled: boolean;
}>;

export type ProviderTool = Readonly<{
  methodName: string;
  label?: string;
}> &
  Readonly<Record<string, JsonValue | undefined>>;

export type ProviderContract = Readonly<{
  rules: string;
  maxLength: number;
  settings: JsonValue;
  tools: readonly ProviderTool[];
}>;

export type ProviderToolCall = Readonly<{
  integrationId: string;
  methodName: string;
  data: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>;

export type ProviderToolOutcome = JsonValue;

export type UploadInput = Readonly<{
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  signal?: AbortSignal;
}>;

export type UploadedMedia = Readonly<{
  id: string;
  path: string;
  name: string;
}>;

export type MediaReference = Readonly<{
  id: string;
  path: string;
}>;

export type PostContent = Readonly<{
  content: string;
  image: readonly MediaReference[];
  delay?: number;
}>;

export type PostDestination = Readonly<{
  integration: Readonly<{ id: string }>;
  value: readonly PostContent[];
  settings: JsonValue;
}>;

export type PostTag = Readonly<{ label: string; value: string }>;

export type CreatePostInput = Readonly<{
  type: 'draft' | 'now' | 'schedule' | 'update';
  date: string;
  shortLink: boolean;
  tags: readonly PostTag[];
  posts: readonly PostDestination[];
  signal?: AbortSignal;
}>;

export type PostOutcome = Readonly<Record<string, JsonValue>>;
export type PostSummary = Readonly<Record<string, JsonValue>>;
export type DeleteOutcome = Readonly<Record<string, JsonValue>>;
export type AnalyticsOutcome = Readonly<Record<string, JsonValue>>;

export type ListPostsInput = Readonly<{
  startDate?: string;
  endDate?: string;
  customer?: string;
  signal?: AbortSignal;
}>;

export type ReadPostInput = Readonly<{ id: string; signal?: AbortSignal }>;
export type ChangePostStatusInput = Readonly<{
  id: string;
  status: 'draft' | 'schedule';
  signal?: AbortSignal;
}>;
export type DeletePostInput = Readonly<{ id: string; signal?: AbortSignal }>;
export type AnalyticsInput = Readonly<{
  postId: string;
  days: number;
  signal?: AbortSignal;
}>;

export interface PostizAgentClient {
  listIntegrations(): Promise<readonly IntegrationSummary[]>;
  getIntegrationSettings(integrationId: string): Promise<ProviderContract>;
  triggerIntegrationTool(input: ProviderToolCall): Promise<ProviderToolOutcome>;
  upload(input: UploadInput): Promise<UploadedMedia>;
  createPost(input: CreatePostInput): Promise<PostOutcome>;
  listPosts(input: ListPostsInput): Promise<readonly PostSummary[]>;
  readPost(input: ReadPostInput): Promise<PostOutcome>;
  changePostStatus(input: ChangePostStatusInput): Promise<PostOutcome>;
  deletePost(input: DeletePostInput): Promise<DeleteOutcome>;
  getPostAnalytics(input: AnalyticsInput): Promise<AnalyticsOutcome>;
}

export interface PostizAgentClientDependencies {
  transport: PostizAgentTransport;
  credential: () => Promise<PostizCredential>;
  clock: () => Date;
}
