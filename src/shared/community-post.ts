export const COMMUNITY_POST_VERIFICATION =
  'I checked the original thread and authorize releasing the claim for retry if no reply exists.' as const;

export interface UnresolvedCommunityPost {
  id: string;
  platform: string;
  threadUrl: string;
  createdAt: string;
  lastError: string | null;
  readyForReview: boolean;
}
