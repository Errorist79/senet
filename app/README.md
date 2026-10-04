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
- The payee screen, which makes a payment request. It also reads a request
  from the camera or from pasted text, judges it, and pays it.

## The payment request that a payee screen reads

A request reaches one judgement, whether the camera read it or a person pasted
it. The judgement checks the signature against the key that the named domain
publishes.

A code that is not a payment request gets a refusal in words. A voucher gets
its own sentence, which names the screen that takes vouchers.

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

Two screens read a code with the camera. The merchant screen reads a voucher,
and the payee screen reads a payment request. One scan button serves each
screen, and both buttons share one implementation in `src/camera.ts`. It closes
the camera when a person stops it, when a code reads, and when a person leaves
the screen.

The decoder is the C++ ZXing library, through its WebAssembly build. The bundle
carries that build inside itself, because the library fetches it over the
network by default, and a merchant may have none. The scanner asks the camera
for a large frame, and it reads the middle square of that frame.

`deploy/scan-check.mjs` is what proves this. It gives Chrome a video file that
holds a symbol, and it drives the deployed page as a person does. A result
means the whole path works: the camera, the frame, the square and the decoder.
After every result, the check asks whether the camera closed. It runs these
cases:

- `merchant`: a symbol of the size that a real voucher takes, at a stated
  number of pixels for each module. The symbol carries bytes that no payer
  signed, so the merchant screen refuses it. The refusal is the proof that the
  bytes arrived.
- `release`: a camera that shows no symbol. Each screen must close its camera
  when a person leaves the screen or presses stop.
- `request`: a request that the deployed service signed. The payee screen must
  judge it signed and offer to pay it.
- `voucher`: a signed voucher. The payee screen must refuse it as a voucher.
- `pay`: two browsers with a passkey each. One makes a request on the payee
  screen, and the check copies the code that the page draws into the video
  file. The other scans that code, pays it, and must show `Paid` with a link to
  the transaction. The check then asks the network for that transaction, and
  it reads the balance of the account that made the request. This case spends
  testnet funds, and it runs only when a person names it.

That check runs against one browser on one machine. It says nothing about any
lens. What is known about phones is smaller: one person read one real voucher
from one phone to another, and it read quickly. Nobody measured how far apart
the two phones may be. Nobody measured which lens a phone opens, or what a
greater distance costs.
