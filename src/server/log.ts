const emit =
  (method: "log" | "warn" | "error") =>
  (message: string, fields?: Record<string, unknown>): void => {
    console[method](
      JSON.stringify(fields ? { message, ...fields } : { message }),
    );
  };

export const log = {
  info: emit("log"),
  warn: emit("warn"),
  error: emit("error"),
};
