export async function readWithRetry<T>(read: () => PromiseLike<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!cause || typeof cause !== "object") throw error;
    const networkFailure = "sourceError" in cause && cause.sourceError ||
      "code" in cause && typeof cause.code === "string" &&
      /^(CONNECT_TIMEOUT|CONNECTION_CLOSED|CONNECTION_ENDED|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(cause.code);
    if (!networkFailure) throw error;
    return await read();
  }
}
