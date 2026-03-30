import { AppUser } from '../shared/types';

declare global {
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}
