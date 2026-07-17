import { auth } from '@/auth';

/**
 * Thrown by `requireUserId()` when there is no valid session. Every downstream API
 * route is expected to catch this by `instanceof` and convert it to an HTTP 401:
 *
 *   catch (e) {
 *     if (e instanceof UnauthorizedError) {
 *       return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *     }
 *     throw e;
 *   }
 *
 * It is exported precisely so that pattern type-checks and matches by `instanceof`,
 * not by string-matching an error message.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The ONE chokepoint every downstream API route (every module: LIB, FIT, TLR, PRP,
 * PLT) must call first to get a trustworthy `userId` for query scoping (PRD §8.3's
 * "全部查询以 session userId 约束" mandate). Never returns undefined/empty silently
 * — always throws `UnauthorizedError` instead, so a route that forgets to handle
 * the error surfaces as a loud 500 rather than a silent cross-user query bug.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new UnauthorizedError();
  }
  return userId;
}
