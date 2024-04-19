import { Server } from "SERVER_DEST";
import { manifest } from "MANIFEST_DEST";
import type { awslambda as AwsLambda } from "@jill64/types-lambda";

declare const awslambda: typeof AwsLambda;

const SERVER = new Server(manifest);
let INIT = false;

export const handler = awslambda.streamifyResponse(
  async (event, responseStream) => {
    if (!INIT) {
      await SERVER.init({ env: process.env as any });
      INIT = true;
    }

    const method = event.requestContext.http.method;
    const encoding = event.isBase64Encoded
      ? "base64"
      : event.headers["content-encoding"] || "utf-8";
    const body = ["GET", "DELETE"].includes(method)
      ? undefined
      : typeof event.body === "string"
        ? Buffer.from(event.body, encoding as BufferEncoding)
        : event.body;
    const request = new Request(
      new URL(
        `${event.rawPath}${
          event.rawQueryString ? `?${event.rawQueryString}` : ""
        }`,
        `${event.headers["x-forwarded-proto"]}://${event.headers["x-forwarded-host"]}`,
      ),
      { method, body },
    );

    Object.keys(event.headers).forEach((key) => {
      request.headers.append(key, event.headers[key]);
    });

    const response = await SERVER.respond(request, {
      getClientAddress: () => event.requestContext.http.sourceIp,
    });

    const headers: [string, string][] = [];

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") {
        headers.push([key, value]);
      }
    });

    responseStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: response.status,
      headers: Object.fromEntries(headers),
      // @ts-ignore
      cookies: response.headers.getSetCookie(),
    });

    responseStream.write("");

    if (!response.body) {
      responseStream.end();
      return;
    }

    if (response.body.locked) {
      responseStream.end();
      return;
    }

    const reader = response.body.getReader();

    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      responseStream.write(chunk.value);
    }

    responseStream.end();
  },
);
