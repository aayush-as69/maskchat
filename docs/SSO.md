# Real Institution SSO (OIDC)

This replaces the production prototype's manually injected verification token with an optional standards-based OpenID Connect login.

## Flow

1. Student selects **Sign in with your institution**.
2. MaskChat creates signed state, nonce and a PKCE verifier.
3. Browser is redirected to the institution identity provider.
4. The provider returns an authorization code.
5. MaskChat exchanges the code over HTTPS and validates the ID token signature using the provider's JWKS.
6. MaskChat validates issuer, audience, expiry, nonce and verified email.
7. The email domain is mapped to an explicitly configured MaskChat institution.
8. A short-lived MaskChat verification token is stored in an HttpOnly browser cookie.
9. The existing `identity:verify` socket flow reads that cookie server-side, so the token is never exposed to page JavaScript.
10. Existing anonymity, institution isolation, moderation and audit rules continue unchanged.

## Google Workspace example

Use the institution's Google Workspace / Cloud Identity OIDC configuration and set:

```env
OIDC_ENABLED=1
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=https://chat.example.edu/api/auth/oidc/callback
OIDC_POST_LOGIN_REDIRECT=https://chat.example.edu/
OIDC_STATE_SECRET=<random-32-plus-character-secret>
OIDC_ALLOWED_DOMAINS=galgotiacollege.edu.in
OIDC_SCOPE=openid email profile
OIDC_MAX_AGE_SECONDS=600
```

For a public PKCE client, `OIDC_CLIENT_SECRET` can remain empty if the identity provider permits that client type. Follow the provider's current configuration requirements.

## Security properties

- Authorization code flow uses PKCE S256.
- State is HMAC signed and short lived.
- Nonce is checked against the ID token.
- ID-token signatures are validated against the provider JWKS.
- Issuer and audience are checked exactly.
- Expired/future tokens are rejected.
- Unverified email claims are rejected when the provider explicitly marks them false.
- Unsupported institution domains are rejected.
- No raw ID token is stored in PostgreSQL or Redis.
- The short-lived MaskChat token is stored in an HttpOnly, Secure cookie rather than a URL fragment, reducing exposure to page scripts, browser history, and server/proxy access logs.
- Stable MaskChat identity keys remain server-only.

## Operational requirements

The institution must configure its IdP redirect URI exactly to `OIDC_REDIRECT_URI`, and the MaskChat deployment must use HTTPS. Do not enable OIDC against an issuer that the institution does not control or explicitly trust.

Phase 26 does not guess institutional policies such as account lifecycle, MFA requirements, or domain ownership. Those must be configured and verified by the institution's identity administrator.

## Browser session security
The OIDC authorization state is bound to a short-lived HttpOnly cookie. After successful login, the short-lived MaskChat verification token is also stored in an HttpOnly, Secure, SameSite=Lax cookie rather than a URL fragment or JavaScript variable. This allows refresh/rejoin while preventing the verification token from being exposed to page scripts or access logs.
