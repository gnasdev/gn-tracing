/**
 * GitHub Issues adapter for product feedback.
 */

export async function createGitHubIssue(params: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<
  { ok: true; htmlUrl: string; number: number } | { ok: false; status: number; detail: string }
> {
  const endpoint = `https://api.github.com/repos/${params.owner}/${params.repo}/issues`;

  const post = async (includeLabels: boolean): Promise<Response> => {
    const payload: Record<string, unknown> = {
      title: params.title,
      body: params.body,
    };
    if (includeLabels && params.labels.length > 0) {
      payload.labels = params.labels;
    }
    return fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "gn-tracing-feedback-proxy",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });
  };

  let response = await post(true);
  // Prefer creating the issue without labels over failing when a label is missing.
  if (
    !response.ok &&
    params.labels.length > 0 &&
    (response.status === 422 || response.status === 400)
  ) {
    response = await post(false);
  }

  if (!response.ok) {
    let detail = `GitHub API HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as { message?: string };
      if (errBody.message) {
        detail = errBody.message;
      }
    } catch {
      // keep status detail
    }
    return { ok: false, status: response.status, detail };
  }

  try {
    const data = (await response.json()) as { html_url?: string; number?: number };
    if (!data.html_url || typeof data.number !== "number") {
      return { ok: false, status: 502, detail: "GitHub API returned an unexpected issue payload." };
    }
    return { ok: true, htmlUrl: data.html_url, number: data.number };
  } catch {
    return { ok: false, status: 502, detail: "GitHub API returned invalid JSON." };
  }
}
