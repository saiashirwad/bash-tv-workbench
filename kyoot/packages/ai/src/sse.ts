export async function* events<T = unknown>(body: ReadableStream): AsyncGenerator<T> {
  let buffer = "";
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 2);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data);
    }
  }
}
