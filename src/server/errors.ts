export type ApiStatus = 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504;

export type OpenAIErrorType =
    | "invalid_request_error"
    | "authentication_error"
    | "rate_limit_error"
    | "timeout_error"
    | "api_error";

export class ApiError extends Error {
    constructor(
        readonly status: ApiStatus,
        readonly type: OpenAIErrorType,
        message: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
}
