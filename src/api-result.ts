export class ApiResult {
  constructor(
    readonly statusCode: number,
    readonly body: Record<string, unknown>,
  ) {}
}
