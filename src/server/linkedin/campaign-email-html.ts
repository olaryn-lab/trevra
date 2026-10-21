/** Canonical campaign email HTML rendering. The campaign worker uses this when
 * drafting, and the shared provider boundary reconstructs it from persisted
 * tracking tokens and targets before a write. No user-supplied HTML is trusted. */
export function escapeCampaignHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function campaignTrackableUrls(body: string): string[] {
  return [
    ...new Set(
      (body.match(/https?:\/\/[^\s<>"']+/gi) ?? [])
        .map((value) => value.replace(/[),.;!?]+$/g, ''))
        .filter((value) => {
          try {
            return ['http:', 'https:'].includes(new URL(value).protocol);
          } catch {
            return false;
          }
        })
    )
  ];
}
export function renderCampaignTrackedContent(
  body: string,
  origin: string,
  token: string,
  replacements: ReadonlyMap<string, string>
): string {
  let escaped = escapeCampaignHtml(body);
  for (const [target, tracked] of replacements) {
    escaped = escaped.replaceAll(
      escapeCampaignHtml(target),
      `<a href="${escapeCampaignHtml(tracked)}">${escapeCampaignHtml(target)}</a>`
    );
  }
  escaped = escaped.replaceAll('\n', '<br>');
  return `${escaped}<img src="${origin}/t/e/${encodeURIComponent(token)}/open.gif" width="1" height="1" alt="" style="display:none" />`;
}
export function renderCampaignHtmlWithFooter(
  body: string,
  footer: string,
  origin: string,
  token: string,
  replacements: ReadonlyMap<string, string>
): string {
  return `${renderCampaignTrackedContent(body, origin, token, replacements)}<br><br>${escapeCampaignHtml(footer).replaceAll('\n', '<br>')}`;
}
