/** Business rules shared by the routes. Mirrors the app's `src/types/domain.ts`. */

/**
 * Four roles:
 *   student       everyday use
 *   society_head  runs a society: events, albums, guest passes, gate scanner
 *   security      the gate: scans tickets, sends safety alerts
 *   uni_admin     the university's administrator ("Admin" in the screens): everything, plus the dashboard
 */
export const ROLES = ['student', 'society_head', 'uni_admin', 'security'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBER_STATUSES = ['pending', 'active', 'rejected', 'suspended'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export type PostKind = 'official' | 'society' | 'alert';

/** Who may publish each kind of update. */
export const POSTING_ROLES: Record<PostKind, readonly Role[]> = {
  official: ['uni_admin'],
  society: ['society_head', 'uni_admin'],
  alert: ['security', 'uni_admin'],
};

export const ADMIN_ROLES: readonly Role[] = ['uni_admin'];
/** May create events and approve guest passes. */
export const ORGANISER_ROLES: readonly Role[] = ['society_head', 'uni_admin'];
/** May run the gate scanner. */
export const SCANNER_ROLES: readonly Role[] = ['security', 'society_head', 'uni_admin'];

export const MAX_GUESTS_PER_STUDENT = 2;

export const EVENT_CATEGORIES = ['Tech', 'Sports', 'Cultural', 'Career', 'Social'] as const;

/** Events from the last 30 days onward are listed; older ones are history. */
export const EVENT_LIST_WINDOW_DAYS = 30;
