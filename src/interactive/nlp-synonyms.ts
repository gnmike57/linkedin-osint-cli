/*
 * Curated data tables for the local NLP parser (spec:
 * docs/superpowers/specs/2026-05-10-shell-nlp-menu-design.md §5).
 *
 * Pure data — no imports, no I/O. Editing these tables tunes the parser;
 * misses are cheap to fix incrementally (§10).
 *
 * Matching model:
 *  - COMMAND_SYNONYMS phrases match the full token sequence contiguously
 *    (case-insensitive), so natural stopword placement ("my profile",
 *    "who is") works; add explicit variants ("classify the title") when
 *    needed. Multi-word phrases score higher than single tokens.
 *  - VALUE_TRIGGERS map words/phrases onto enum/boolean Zod fields.
 *  - URN-typed fields (geo, URN ids) are never guessed offline.
 */

/** Per-command synonym phrases, keyed by CommandDefinition.name. */
export const COMMAND_SYNONYMS: Record<string, string[]> = {
  // — profile (9)
  profile_view: ['view profile', 'view a profile', 'view the profile', 'who is', 'look up', 'profile of', 'open profile'],
  profile_me: ['my profile', 'own profile', 'who am i', 'my linkedin'],
  'profile_contact-info': ['contact info', 'contact details', 'email of', 'phone of'],
  profile_skills: ['list skills', 'skills of', 'what skills', 'skill list'],
  profile_network: ['network info', 'network of', 'connections of', 'how many connections', 'followers of'],
  profile_badges: ['member badges', 'badges of', 'has premium', 'premium badge'],
  profile_privacy: ['privacy settings', 'privacy of'],
  profile_posts: ['posts from', 'posts by', 'recent posts'],
  profile_disconnect: ['remove connection', 'disconnect from', 'unfriend'],
  // — posts (3)
  posts_create: ['write a post', 'create a post', 'new post', 'share an update', 'post'],
  posts_edit: ['edit post', 'update post', 'edit my post'],
  posts_delete: ['delete post', 'remove post', 'delete my post'],
  // — feed (3)
  feed_view: ['my feed', 'view feed', 'home feed', 'feed timeline'],
  feed_user: ['activity of', 'feed of', 'user feed'],
  feed_company: ['company feed', 'company updates', 'page updates'],
  // — engage (5)
  engage_react: ['react to', 'like', 'react', 'clap', 'celebrate', 'heart', 'insightful', 'funny'],
  engage_reactions: ['who liked', 'reactions on', 'reactions to', 'list reactions'],
  engage_comment: ['comment on', 'write a comment', 'comment'],
  'engage_comments-list': ['list comments', 'comments on', 'who commented'],
  engage_share: ['share a post', 'share post', 'repost', 'reshare'],
  // — connections (7)
  connections_send: ['connect with', 'connect to', 'add connection', 'invite to connect', 'send invite', 'connect', 'add', 'invite'],
  connections_received: ['invitations received', 'received invitations', 'pending invites', 'who invited me'],
  connections_sent: ['invitations sent', 'sent invitations', 'sent invites', 'sent requests'],
  connections_accept: ['accept invitation', 'accept invite', 'accept connection'],
  connections_reject: ['reject invitation', 'ignore invitation', 'reject invite'],
  connections_withdraw: ['withdraw invitation', 'withdraw invite', 'withdraw request'],
  connections_remove: ['remove contact', 'remove from connections', 'delete connection'],
  // — messaging (6)
  messaging_conversations: ['list conversations', 'my messages', 'show inbox', 'inbox'],
  'messaging_conversation-with': ['conversation with', 'chat with', 'thread with'],
  messaging_messages: ['read messages', 'messages in', 'conversation messages'],
  messaging_send: ['reply to conversation', 'reply in', 'reply'],
  'messaging_send-new': ['send a message', 'send message', 'new message to', 'dm', 'message', 'text'],
  'messaging_mark-read': ['mark read', 'mark as read'],
  // — search (4)
  search_people: ['find people', 'find the people', 'people search', 'search people', 'find someone'],
  search_companies: ['search companies', 'company search', 'look up companies'],
  search_jobs: ['find jobs', 'job search', 'search jobs'],
  search_posts: ['search posts', 'find posts', 'post search'],
  // — companies (3)
  companies_view: ['company profile', 'view company', 'company page', 'about company'],
  companies_follow: ['follow a company', 'follow company'],
  companies_unfollow: ['unfollow company', 'stop following'],
  // — jobs (2)
  jobs_view: ['job details', 'view job', 'job posting', 'open job'],
  jobs_skills: ['skill match', 'job skills', 'skills match', 'match my skills'],
  // — analytics (1)
  'analytics_profile-views': ['who viewed', 'who viewed my profile', 'profile views'],
  // — osint (13)
  osint_discover: ['discover companies', 'find companies', 'companies in'],
  osint_employees: ['scrape employees', 'scrape the employees', 'employee list', 'people at', 'staff at', 'who works at', 'scrape'],
  osint_names: ['generate usernames', 'username permutations', 'name permutations', 'make usernames'],
  osint_classify: ['classify titles', 'classify the title', 'classify a title', 'classify this title', 'classify job title', 'classify title', 'classify'],
  'osint_ai-score': ['score companies', 'ai score', 'relevance score'],
  'osint_ai-classify': ['ai classify', 'ai classification batch'],
  osint_orgchart: ['org chart', 'hierarchy chart', 'build org chart'],
  osint_matrix: ['html matrix', 'matrix page', 'generate matrix', 'matrix org chart'],
  osint_stats: ['classification stats', 'title stats', 'distribution stats'],
  osint_scan: ['scan results', 'health check', 'scan directory'],
  'osint_email-lookup': ['email lookup', 'look up emails', 'delve lookup'],
  'osint_deep-dive': ['deep dive', 'profile deep dive', 'dive into profile'],
  osint_funnel: ['full funnel', 'funnel pipeline', 'run funnel'],
  // __TABLE_PART2__
};

/**
 * Commands that mutate state on LinkedIn. NLP phrases that land on one of
 * these always show a red ⚠ and require an explicit `y` (§5.3).
 */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'posts_create',
  'posts_edit',
  'posts_delete',
  'messaging_send',
  'messaging_send-new',
  'connections_send',
  'connections_accept',
  'connections_reject',
  'connections_withdraw',
  'profile_disconnect',
  'engage_react',
  'engage_comment',
  'engage_share',
  'companies_follow',
  'companies_unfollow',
]);

export function isWriteCommand(commandName: string): boolean {
  return WRITE_COMMANDS.has(commandName);
}
/**
 * Enum/boolean trigger table. Keys are tried longest-first; a trigger only
 * fills a field the command actually declares, and enum values are checked
 * against the Zod enum before filling.
 */
export const VALUE_TRIGGERS: Record<string, { field: string; value: unknown }> = {
  'connections only': { field: 'visibility', value: 'connections' },
  'use ai': { field: 'use_ai', value: true },
  'with ai': { field: 'use_ai', value: true },
  newest: { field: 'sort', value: 'REVERSE_CHRONOLOGICAL' },
  latest: { field: 'sort', value: 'REVERSE_CHRONOLOGICAL' },
  relevant: { field: 'sort', value: 'RELEVANCE' },
  ai: { field: 'use_ai', value: true },
  remote: { field: 'remote', value: true },
  geoblast: { field: 'geoblast', value: true },
  verbose: { field: 'verbose', value: true },
};

/** Reaction words → engage_react `type` enum (§5.4). */
export const REACTION_WORDS: Record<string, string> = {
  like: 'LIKE',
  clap: 'PRAISE',
  celebrate: 'PRAISE',
  support: 'APPRECIATION',
  love: 'EMPATHY',
  heart: 'EMPATHY',
  insightful: 'INTEREST',
  funny: 'ENTERTAINMENT',
};

/**
 * Numeric slot affinity (§5.4): context words adjacent to an integer route it
 * into `count` / `limit` / `start`; an integer preceded by any numeric field's
 * own name ("depth 3", "max-profiles 200") always fills that field.
 */
export const NUMBER_CONTEXT: Record<'count' | 'limit' | 'start', string[]> = {
  count: ['count', 'last', 'top', 'first', 'posts', 'people', 'jobs'],
  limit: ['limit', 'results'],
  start: ['start', 'offset', 'skip'],
};

/** String fields that may legitimately receive a bare long-digit token. */
export const URN_FIELD_HINTS: ReadonlySet<string> = new Set([
  'post_urn',
  'job_id',
  'invitation_id',
  'share_urn',
  'urn_id',
  'company_id',
  'conversation_id',
]);

/**
 * The only free-string location slot NLP fills from "in <place>" phrases.
 * URN-typed location fields (search_people --geo, osint --geo) are never
 * guessed offline — they fall through to the guided prompt (§5.4).
 */
export const LOCATION_FIELD = 'location';

/** Fields NLP never auto-fills (URN semantics, guided prompt only). */
export const NEVER_GUESSED_FIELDS: ReadonlySet<string> = new Set(['geo']);

/**
 * Stopwords ignored for catalog-overlap scoring and unclaimed-token reports.
 * They still participate in synonym phrase matching (full-sequence match).
 */
export const OVERLAP_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'with',
  'my', 'me', 'us', 'our', 'their', 'all', 'it', 'is', 'are', 'this', 'that',
  'these', 'those', 'from', 'who', 'how', 'what', 'when', 'you', 'your', 'i',
  'am', 'do', 'does', 'please', 'some', 'any',
]);
