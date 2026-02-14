import { env } from '../config/env';

export type SocialOAuthProvider = 'google' | 'github';

export type SocialOAuthProviderConfig = {
  provider: SocialOAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
};

export type SocialOAuthProviderReadiness = {
  provider: SocialOAuthProvider;
  configured: boolean;
  missing: string[];
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userInfoUrl: string | null;
};

function nonEmpty(value: string | undefined | null) {
  return Boolean(value && value.trim().length > 0);
}

export function getSocialOAuthProviderConfig(provider: SocialOAuthProvider): SocialOAuthProviderConfig | null {
  if (provider === 'google') {
    if (!nonEmpty(env.OAUTH_GOOGLE_CLIENT_ID) || !nonEmpty(env.OAUTH_GOOGLE_CLIENT_SECRET) || !nonEmpty(env.OAUTH_GOOGLE_REDIRECT_URI)) {
      return null;
    }
    return {
      provider,
      clientId: env.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
      redirectUri: env.OAUTH_GOOGLE_REDIRECT_URI,
      authorizationUrl: env.OAUTH_GOOGLE_AUTH_URL,
      tokenUrl: env.OAUTH_GOOGLE_TOKEN_URL,
      userInfoUrl: env.OAUTH_GOOGLE_USERINFO_URL,
      scope: 'openid email profile',
    };
  }

  if (provider === 'github') {
    if (!nonEmpty(env.OAUTH_GITHUB_CLIENT_ID) || !nonEmpty(env.OAUTH_GITHUB_CLIENT_SECRET) || !nonEmpty(env.OAUTH_GITHUB_REDIRECT_URI)) {
      return null;
    }
    return {
      provider,
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      redirectUri: env.OAUTH_GITHUB_REDIRECT_URI,
      authorizationUrl: env.OAUTH_GITHUB_AUTH_URL,
      tokenUrl: env.OAUTH_GITHUB_TOKEN_URL,
      userInfoUrl: env.OAUTH_GITHUB_USERINFO_URL,
      scope: 'read:user user:email',
    };
  }

  return null;
}

function readinessFor(provider: SocialOAuthProvider): SocialOAuthProviderReadiness {
  const missing: string[] = [];
  if (provider === 'google') {
    if (!nonEmpty(env.OAUTH_GOOGLE_CLIENT_ID)) missing.push('OAUTH_GOOGLE_CLIENT_ID');
    if (!nonEmpty(env.OAUTH_GOOGLE_CLIENT_SECRET)) missing.push('OAUTH_GOOGLE_CLIENT_SECRET');
    if (!nonEmpty(env.OAUTH_GOOGLE_REDIRECT_URI)) missing.push('OAUTH_GOOGLE_REDIRECT_URI');
    return {
      provider,
      configured: missing.length === 0,
      missing,
      authorizationUrl: env.OAUTH_GOOGLE_AUTH_URL || null,
      tokenUrl: env.OAUTH_GOOGLE_TOKEN_URL || null,
      userInfoUrl: env.OAUTH_GOOGLE_USERINFO_URL || null,
    };
  }

  if (provider === 'github') {
    if (!nonEmpty(env.OAUTH_GITHUB_CLIENT_ID)) missing.push('OAUTH_GITHUB_CLIENT_ID');
    if (!nonEmpty(env.OAUTH_GITHUB_CLIENT_SECRET)) missing.push('OAUTH_GITHUB_CLIENT_SECRET');
    if (!nonEmpty(env.OAUTH_GITHUB_REDIRECT_URI)) missing.push('OAUTH_GITHUB_REDIRECT_URI');
    return {
      provider,
      configured: missing.length === 0,
      missing,
      authorizationUrl: env.OAUTH_GITHUB_AUTH_URL || null,
      tokenUrl: env.OAUTH_GITHUB_TOKEN_URL || null,
      userInfoUrl: env.OAUTH_GITHUB_USERINFO_URL || null,
    };
  }

  return {
    provider,
    configured: false,
    missing: ['unknown_provider'],
    authorizationUrl: null,
    tokenUrl: null,
    userInfoUrl: null,
  };
}

export function getSocialOAuthProviderReadiness(): SocialOAuthProviderReadiness[] {
  return [readinessFor('google'), readinessFor('github')];
}

