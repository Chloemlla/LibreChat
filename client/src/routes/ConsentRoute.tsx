import { AuthContextProvider } from '~/hooks/AuthContext';
import { Consent } from '~/components/OAuth';

/**
 * The consent screen sits outside `AuthLayout` because it is reached by redirect from a
 * third-party app, so it mounts its own provider to get the silent refresh that turns the
 * session cookie into an Authorization header. `optional` keeps an unauthenticated visitor
 * on the page: the provider endpoint already answers `login_required` with the login URL
 * that carries the authorize request as `redirect_to`, and following that is the screen's
 * job, not the provider's.
 */
export default function ConsentRoute() {
  return (
    <AuthContextProvider authConfig={{ loginRedirect: '/login', optional: true }}>
      <Consent />
    </AuthContextProvider>
  );
}
