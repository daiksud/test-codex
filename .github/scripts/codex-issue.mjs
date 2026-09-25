export const MAX_ISSUE_RUNTIME_MS = 24 * 60 * 60 * 1000;

export function remainingIssueBudgetMs(issueCreatedAt, nowMs) {
  const issueCreatedAtMs = Date.parse(issueCreatedAt);
  if (!Number.isFinite(issueCreatedAtMs) || !Number.isFinite(nowMs)) {
    throw new TypeError("Issue creation time and current time must be valid");
  }

  const deadlineMs = issueCreatedAtMs + MAX_ISSUE_RUNTIME_MS;
  return Math.min(MAX_ISSUE_RUNTIME_MS, Math.max(0, deadlineMs - nowMs));
}

export function startCodexIfWithinDeadline(issueCreatedAt, nowMs, launchCodex) {
  const remainingMs = remainingIssueBudgetMs(issueCreatedAt, nowMs);
  if (remainingMs === 0) {
    return { status: "expired", remainingMs: 0 };
  }

  return {
    status: "started",
    remainingMs,
    launchResult: launchCodex(remainingMs),
  };
}
