/** 业务错误：带 HTTP 状态码与给用户看的中文说明。 */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "资源") => new AppError(404, `${what}不存在`);
export const forbidden = () => new AppError(403, "没有权限");
