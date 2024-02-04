import { parse as parseURL } from 'url';
import { AES, enc } from 'crypto-js';
import * as passport from 'passport';
// const Auth0Strategy = require('passport-auth0')
const GitLabStrategy = require('passport-gitlab2');
import { NextFunction, Request, Response } from 'express';
const PromiseRouter = require('express-promise-router');
import * as session from 'express-session';
const MySQLStore = require('express-mysql-session')(session);
import UserClient from './lib/model/user-client';
import DB from './lib/model/db';
import { earnBonus } from './lib/model/achievements';
import { getConfig } from './config-helper';
import { ChallengeTeamToken, ChallengeToken } from 'common';

const {
  ENVIRONMENT,
  MYSQLHOST,
  MYSQLDBNAME,
  MYSQLUSER,
  MYSQLPASS,
  PROD,
  SECRET,
  // AUTH0: { DOMAIN, CLIENT_ID, CLIENT_SECRET },
  GITLAB: { DOMAIN, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI },
} = getConfig();
const CALLBACK_URL = '/callback';

const router = PromiseRouter();

router.use(require('cookie-parser')());
router.use(
  session({
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      secure: PROD,
    },
    secret: SECRET,
    store: new MySQLStore({
      host: MYSQLHOST,
      user: MYSQLUSER,
      password: MYSQLPASS,
      database: MYSQLDBNAME,
      createDatabaseTable: false,
    }),
    proxy: true,
    resave: false,
    saveUninitialized: false,
  })
);
router.use(passport.initialize());
router.use(passport.session());

passport.serializeUser((user: any, done: Function) => done(null, user));
passport.deserializeUser((sessionUser: any, done: Function) =>
  done(null, sessionUser)
);

if (DOMAIN) {
  // Auth0Strategy.prototype.authorizationParams = function (options: any) {
  //   var options = options || {}
  //
  //   const params: any = {}
  //   if (options.connection && typeof options.connection === 'string') {
  //     params.connection = options.connection
  //   }
  //   if (options.audience && typeof options.audience === 'string') {
  //     params.audience = options.audience
  //   }
  //   params.account_verification = true
  //
  //   return params
  // }

  // const strategy = new Auth0Strategy(
  //   {
  //     domain: DOMAIN,
  //     clientID: CLIENT_ID,
  //     clientSecret: CLIENT_SECRET,
  //     callbackURL:
  //       ((
  //         {
  //           stage: 'https://commonvoice.allizom.org',
  //           prod: 'https://commonvoice.mozilla.org',
  //           dev: 'https://dev.voice.mozit.cloud',
  //           sandbox: 'https://sandbox.commonvoice.allizom.org',
  //         } as any
  //       )[ENVIRONMENT] || '') + CALLBACK_URL,
  //     scope: 'openid email',
  //   },
  //   (
  //     accessToken: any,
  //     refreshToken: any,
  //     extraParams: any,
  //     profile: any,
  //     done: any
  //   ) => done(null, profile)
  // )

  passport.use(
    new GitLabStrategy(
      {
        clientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        callbackURL: REDIRECT_URI,
        baseURL: DOMAIN,
      },
      function (_accessToken: any, _refreshToken: any, profile: any, cb: any) {
        return cb(null, profile);
      }
    )
  );
} else {
  console.log('No GitLab configuration found');
}

function parseState(request: Request) {
  const { state } = request.query;

  if (!state || typeof state !== 'string') {
    return {};
  }

  return JSON.parse(AES.decrypt(state, SECRET).toString(enc.Utf8));
}

router.get(
  CALLBACK_URL,
  passport.authenticate('gitlab', { failureRedirect: '/login' }),
  async (request: Request, response: Response) => {
    console.log(request.headers);
    console.log(response.get('Set-Cookie'));

    const {
      user,
      query: { state },
      session,
    } = request;

    console.log('user', user);
    console.log('state', state);
    console.log('session', session);

    let currentState = {
      locale: '',
      old_user: '',
      old_email: '',
      redirect: '',
      enrollment: { challenge: '', team: '', invite: '', referer: '' },
    };

    if (state && typeof state === 'string') {
      const bytes = AES.decrypt(state, SECRET);
      const decryptedData = bytes.toString(enc.Utf8);
      currentState = JSON.parse(decryptedData);
    }

    const { locale, old_user, old_email, redirect, enrollment } = currentState;
    console.log('currentState', currentState);

    const basePath = locale ? `/${locale}/` : '/';
    if (!user) {
      response.redirect(basePath + 'login-failure');
    } else if (old_user) {
      console.log('old user path');
      const success = await UserClient.updateSSO(
        old_email,
        user.emails[0].value
      );
      if (!success) {
        session.passport.user = old_user;
      }
      response.redirect('/profile/settings?success=' + success.toString());
    } else if (enrollment?.challenge && enrollment?.team) {
      console.log('enrollment path');
      if (
        !(await UserClient.enrollRegisteredUser(
          user.emails[0].value,
          enrollment.challenge as ChallengeToken,
          enrollment.team as ChallengeTeamToken,
          enrollment.invite,
          enrollment.referer
        ))
      ) {
        // if the user is unregistered, pass enrollment to frontend
        user.enrollment = enrollment;
      } else {
        // if the user is already registered, now they should be enrolled
        // [TODO] there should be an elegant way to get the client_id here
        const client_id = await UserClient.findClientId(user.emails[0].value);
        await earnBonus('sign_up_first_three_days', [
          enrollment.challenge,
          client_id,
        ]);
        await earnBonus('invite_signup', [
          client_id,
          enrollment.invite,
          enrollment.invite,
          enrollment.challenge,
        ]);
      }

      // [BUG] try refresh the challenge board, toast will show again, even though DB won't give it the same achievement again
      response.redirect(
        redirect ||
          `${basePath}login-success?challenge=${enrollment.challenge}&achievement=1`
      );
    } else {
      console.log('normal path');

      console.log(response.get('Set-Cookie'));

      response.redirect(redirect || basePath + 'login-success');
    }
  }
);

router.get('/login', (request: Request, response: Response) => {
  const { headers, user, query } = request;
  let locale = '';
  if (headers.referer) {
    const pathParts = parseURL(headers.referer).pathname?.split('/');
    locale = pathParts?.[1] || '';
  }
  passport.authenticate('gitlab', {
    state: AES.encrypt(
      JSON.stringify({
        locale,
        ...(user && query.change_email !== undefined
          ? {
              old_user: request.user,
              old_email: user.emails[0].value,
            }
          : {}),
        redirect: query.redirect || null,
        enrollment: {
          challenge: query.challenge || null,
          team: query.team || null,
          invite: query.invite || null,
          referer: query.referer || null,
        },
      }),
      SECRET
    ).toString(),
  } as any)(request, response);
});

router.get('/logout', (request: Request, response: Response) => {
  response.clearCookie('connect.sid');
  response.redirect('/');
});

export default router;

const db = new DB();
export async function authMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
) {
  if (request.user) {
    const accountClientId = await UserClient.findClientId(
      request.user.emails[0].value
    );
    if (accountClientId) {
      request.client_id = accountClientId;
      next();
      return;
    }
  }

  const [authType, credentials] = (request.header('Authorization') || '').split(
    ' '
  );
  if (authType === 'Basic') {
    const [client_id, auth_token] = Buffer.from(credentials, 'base64')
      .toString()
      .split(':');
    if (await UserClient.hasSSO(client_id)) {
      response.sendStatus(401);
      return;
    } else {
      const verified = await db.createOrVerifyUserClient(client_id, auth_token);
      if (!verified) {
        response.sendStatus(401);
        return;
      }
    }
    request.client_id = client_id;
  }

  next();
}
