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
- The payer screen, which mints a voucher with no network and draws its code.
- The merchant screen, which scans a code or takes a pasted voucher, names the
  account that receives the funds, and shows one typed outcome.
- The payee screen, which makes a payment request, and judges one.

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

`npm test --workspace @senet/app` runs the type checker and then the build.

## The scanner, and what proves it

The merchant screen reads a code with the camera. The decoder is the C++ ZXing
library, through its WebAssembly build. The bundle carries that build inside
itself, because the library fetches it over the network by default, and a
merchant may have none. The scanner asks the camera for a large frame, and it
reads the middle square of that frame.

`deploy/scan-check.mjs` is what proves this. It gives Chrome a video file that
holds a symbol of the size that a real voucher takes. The file carries a stated
number of pixels for each module. The check then drives the merchant screen as
a merchant does. A read means the whole path works: the camera, the frame, the
square and the decoder. The symbol carries bytes that no payer signed, so the screen
refuses it, and the refusal is the proof that the bytes arrived.

That check runs against one browser on one machine. It says nothing about any
lens. What is known about phones is smaller: one person read one real voucher
from one phone to another, and it read quickly. Nobody measured how far apart
the two phones may be. Nobody measured which lens a phone opens, or what a
greater distance costs.
