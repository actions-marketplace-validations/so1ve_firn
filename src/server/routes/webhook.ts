import type { Context } from "hono";

import { errorMessage } from "../../shared/format.ts";
import type { AppBindings } from "../app.ts";
import { deletePrScope } from "../db.ts";
import { verifyWebhookSignature } from "../github.ts";
import { log } from "../log.ts";

interface PullRequestWebhook {
  action: string;
  repository: { name: string; owner: { id: number } };
  pull_request: { number: number };
}

export async function handleWebhook(
  c: Context<AppBindings>,
): Promise<Response> {
  const config = c.get("config");
  if (!config.webhookSecret) {
    return c.text("webhooks not enabled", 404);
  }
  const sigHeader = c.req.header("x-hub-signature-256");
  if (!sigHeader) {
    return c.text("missing webhook signature", 401);
  }

  const rawBody = await c.req.arrayBuffer();
  if (
    !(await verifyWebhookSignature(config.webhookSecret, sigHeader, rawBody))
  ) {
    log.warn("rejected GitHub webhook with invalid signature");

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
    return c.text(`invalid webhook JSON: ${errorMessage(error)}`, 400);
  }

  if (payload.action === "closed") {
    const owner = config.ownersByGithubId.get(payload.repository.owner.id);
    if (owner) {
      const removed = await deletePrScope(
        c.get("db"),
        owner.name,
        payload.repository.name,
        payload.pull_request.number,
      );
      log.info("cleaned PR overlay on pull_request closed webhook", {
        owner: owner.name,
        repo: payload.repository.name,
        pr: payload.pull_request.number,
        removed,
      });
    }
  }

  return c.body(null, 204);
}
