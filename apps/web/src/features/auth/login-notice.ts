/**
 * A one-shot message shown on the login screen after the app signs the user out on purpose (a password change).
 *
 * sessionStorage, not router state: dropping the session makes RequireAuth redirect by itself, so whichever
 * navigation happens to win the race must still be able to show the message. It is a plain UI string — nothing
 * auth-related is ever stored — and it is removed the first time it is read.
 */
const KEY = 'hr:login-notice';

export function setLoginNotice(message: string): void {
  try {
    sessionStorage.setItem(KEY, message);
  } catch {
    // private mode or blocked storage: the message is a nicety, never a requirement
  }
}

export function takeLoginNotice(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value) sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}
