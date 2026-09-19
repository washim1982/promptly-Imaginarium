// Renderer side of the optional Auth0 app login (electron/auth0/). Profile
// only — tokens never reach this side.

import { cleanError, requireDesktop } from './desktop';

export interface Auth0User {
  sub: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface Auth0Status {
  configured: boolean;
  clientSource: 'env' | 'saved' | null;
  domain: string;
  /** The URL to put in the Auth0 application's Allowed Callback URLs. */
  callbackUrl: string;
  loggedIn: boolean;
  user: Auth0User | null;
  canPersist: boolean;
}

interface Auth0Bridge {
  status(): Promise<Auth0Status>;
  verify(): Promise<Auth0Status>;
  saveClient(input: { domain: string; clientId: string }): Promise<Auth0Status>;
  clearClient(): Promise<Auth0Status>;
  login(): Promise<Auth0Status>;
  cancelLogin(): Promise<void>;
  logout(): Promise<Auth0Status>;
}

const bridge = () => (requireDesktop() as unknown as { auth0: Auth0Bridge }).auth0;

export const auth0Api: Auth0Bridge = new Proxy({} as Auth0Bridge, {
  get(_t, key: keyof Auth0Bridge) {
    return async (...args: unknown[]) => {
      try {
        return await (bridge()[key] as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        throw new Error(cleanError(err));
      }
    };
  },
});

export function initialsOf(user: Auth0User | null): string {
  const source = (user?.name || user?.email || '?').replace(/@.*/, '');
  return (
    source
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}
