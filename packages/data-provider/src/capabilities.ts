/**
 * The canonical set of base system capabilities.
 *
 * These are used by the admin panel and LibreChat API to gate access to
 * admin features. Config-section-derived capabilities (e.g.
 * `manage:configs:endpoints`) are built on top of these where the
 * configSchema is available.
 */
export const SystemCapabilities = {
  ACCESS_ADMIN: 'access:admin',
  READ_USERS: 'read:users',
  MANAGE_USERS: 'manage:users',
  READ_GROUPS: 'read:groups',
  MANAGE_GROUPS: 'manage:groups',
  READ_ROLES: 'read:roles',
  MANAGE_ROLES: 'manage:roles',
  READ_CONFIGS: 'read:configs',
  MANAGE_CONFIGS: 'manage:configs',
  ASSIGN_CONFIGS: 'assign:configs',
  READ_USAGE: 'read:usage',
  READ_INSIGHTS: 'read:insights',
  READ_AGENTS: 'read:agents',
  MANAGE_AGENTS: 'manage:agents',
  MANAGE_MCP_SERVERS: 'manage:mcpservers',
  /** Enrolls and revokes deployment-owned Code API workers. */
  MANAGE_CODE_ENVIRONMENTS: 'manage:code_environments',
  READ_PROMPTS: 'read:prompts',
  MANAGE_PROMPTS: 'manage:prompts',
  READ_SKILLS: 'read:skills',
  MANAGE_SKILLS: 'manage:skills',
  READ_SHARED_LINKS: 'read:sharedlinks',
  MANAGE_SHARED_LINKS: 'manage:sharedlinks',
  /** Reserved — not yet enforced by any middleware. */
  READ_ASSISTANTS: 'read:assistants',
  MANAGE_ASSISTANTS: 'manage:assistants',
  /**
   * Required to list, view, and CSV-export the SystemGrant audit log. Append-only
   * by design, so there is no MANAGE counterpart — modifying historical entries
   * would defeat the forensic guarantee.
   */
  READ_AUDIT_LOG: 'read:audit_log',
} as const;

/** Base capabilities derived from the SystemCapabilities constant. */
export type BaseSystemCapability = (typeof SystemCapabilities)[keyof typeof SystemCapabilities];

/** Every base capability, in declaration order — what the capability surface asks about. */
export const BASE_SYSTEM_CAPABILITIES: BaseSystemCapability[] = Object.values(SystemCapabilities);
