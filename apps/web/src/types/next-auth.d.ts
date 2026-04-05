// This only appears unused, but it is required to properly augment the JWT type
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Session, JWT } from 'next-auth';

declare module 'next-auth' {
  interface JWT {
    iat: number;
    exp: number;
    sub: string;
    kiloUserId: string;
    pepper?: string | null;
    version: number;
    isNewUser?: boolean;
    isAdmin: boolean;
  }
  interface Session {
    kiloUserId: string;
    pepper?: string | null;
    isNewUser: boolean;
    isAdmin: boolean; //also probably not a good idea; no reason to trust this over in-db state and we need that anyhow.
    user: {
      //This object should be removed.  All of it is derived from in-db state, and it might be out of date.
      id: string;
      name: string;
      email: string;
      image?: string | null;
    };
  }
}

// This only appears unused, but it is required to properly augment the JWTPayload type
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { JwtPayload } from 'jsonwebtoken';

declare module 'jsonwebtoken' {
  interface JwtPayload {
    sub: string;
    exp: number;
    kiloUserId: string;
    version: number;
  }
}
