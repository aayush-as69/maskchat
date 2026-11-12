# MaskChat Security

## Privacy model

Participants do not receive each other's real identity. The client receives an explicit allow-list of mentor fields rather than arbitrary account records.

## Authentication

Development authentication is intentionally weaker. Production requires the configured trusted-token or OIDC path.

## Alias separation

Public aliases and internal identity references use separate secrets. This prevents the public alias from becoming a direct identifier for moderation state.

## Moderation

The system filters contact details, links, attachments and abusive language before delivery. Reports and bans are handled through moderator endpoints. The filter is a first-pass control, not a guarantee against every evasion technique.

## Abuse controls

The implementation includes identity-based rate limits, cooldowns, repeat-violation escalation, request body limits and request rate limiting.

## Admin

Admin endpoints are token-gated. Keep ADMIN_TOKEN secret and restrict its operational scope.

## Production requirements

Use HTTPS, strong secrets, controlled OIDC/trusted-token configuration, durable storage, monitoring, backups and a formal security review before institutional deployment.