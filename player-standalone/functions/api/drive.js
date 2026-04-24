export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fileId = url.searchParams.get("id");

  if (!fileId) {
    return new Response("Missing id query parameter", { status: 400 });
  }

  const upstreamUrl = new URL("https://drive.usercontent.google.com/download");
  upstreamUrl.searchParams.set("id", fileId);
  upstreamUrl.searchParams.set("export", "download");

  const upstreamHeaders = new Headers();
  const range = context.request.headers.get("range");
  if (range) {
    upstreamHeaders.set("range", range);
  }

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });

  const responseHeaders = new Headers();
  for (const headerName of [
    "accept-ranges",
    "content-disposition",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const headerValue = upstreamResponse.headers.get(headerName);
    if (headerValue) {
      responseHeaders.set(headerName, headerValue);
    }
  }

  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("cache-control", "public, max-age=86400");
  responseHeaders.set("x-content-type-options", "nosniff");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
