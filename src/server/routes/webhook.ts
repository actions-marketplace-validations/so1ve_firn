import type { Context } from "hono";

import type { AppBindings } from "../app.ts";
import { deletePrScope } from "../db.ts";
import { verifyWebhookSignature } from "../github.ts";

interface PullRequestWebhook {
  action: string;
  repository: {
    name: string;
    owner: { id: number };
  };
  pull_request: {
    number: number;
  };
}

export async function handleWebhook(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  const secret = config.webhookSecret;
  if (!secret) {
    return c.text("webhooks not enabled", 404);
  }

  const sigHeader = c.req.header("x-hub-signature-256");
  if (!sigHeader) {
    return c.text("missing webhook signature", 401);
  }

  const rawBody = await c.req.arrayBuffer();
  if (!(await verifyWebhookSignature(secret, sigHeader, rawBody))) {
    console.warn(
      JSON.stringify({
        message: "rejected GitHub webhook with invalid signature",
      }),
    );

    return c.text("invalid webhook signature", 401);
  }

  if (c.req.header("x-github-event") !== "pull_request") {
    return c.body(null, 204);
  }

  let payload: PullRequestWebhook;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(rawBody),
    ) as PullRequestWebhook;
  } catch (error) {
    return c.text(
      `invalid webhook JSON: ${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }

  if (payload.action !== "closed") {
    return c.body(null, 204);
  }

  const owner = config.ownersByGithubId.get(payload.repository.owner.id);
  if (owner) {
    const removed = await deletePrScope(
      c.get("db"),
      owner.name,
      payload.repository.name,
      payload.pull_request.number,
    );
    console.log(
      JSON.stringify({
        message: "cleaned PR overlay on pull_request closed webhook",
        owner: owner.name,
        repo: payload.repository.name,
        pr: payload.pull_request.number,
        removed,
      }),
    );
  }

  return c.body(null, 204);
}
