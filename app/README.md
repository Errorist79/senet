# @senet/app

The application. It runs in payer mode and in merchant mode, and it installs
on a phone as a progressive web application.

The application holds no protocol logic. It reads the chain identities from the
service, it sends a voucher to the service, and it shows what the service
answers. The voucher rules live in the library, and the fee payment lives in
the service.

## What this build holds

- The shell, which installs the service worker and shows the network, the
  contract and the last ledger that the device saw.
- The merchant screen, which takes a pasted voucher, names the account that
  receives the funds, and shows one typed outcome.

The camera and the payer screen arrive with the scanner and the payer mode.

## The outcome that a merchant reads

The service answers one outcome from a fixed list. `src/outcomes.ts` maps each
one to a title, a sentence that says what a person does next, and a colour. An
outcome that this build does not know reads as an unknown outcome, and never as
a blank screen.

The two lists must hold the same names. A new outcome in the service needs a
new sentence here.

## Offline

A payer mints a voucher with no network, so the application itself must open
with no network. The service worker holds the shell files and serves them from
the cache. It never holds a service reply, because a stale balance or a stale
ledger is worse than no answer at all.

## Build

```
npm run build --workspace @senet/app
```

The build writes `dist`, and the web server publishes that directory. It names
four files, and the cache rules in the web server configuration depend on the
names: `index.html`, `app.js`, `app.css` and `sw.js`.

`npm test --workspace @senet/app` runs the type checker and then the build. The
type checker is the test: the screens need real phones and cameras, and a
browser suite for one form would cost more than it returns.
