/** `Retry-After` in delay-seconds, the form the gateway sends; an HTTP date or anything else gives none. Internal to the SDK. */
export const retryAfterSeconds = (headers: Headers) => {
  const value = headers.get("retry-after")?.trim();
  return value && /^\d{1,7}$/.test(value) ? Number(value) : undefined;
};
