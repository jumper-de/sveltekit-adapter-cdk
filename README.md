This SvelteKit adapter exports your SvelteKit project as a fully self contained AWS CDK construct, this allows you to import your SvelteKit server just like you would any other CDK construct package.

## Usage

### Installation

The package is available on [NPM](https://www.npmjs.com) and can be installed using your package manager of choice:

```bash
npm i @flit/sveltekit-adapter-cdk
```

```bash
pnpm add @flit/sveltekit-adapter-cdk
```

```bash
yarn add @flit/sveltekit-adapter-cdk
```

### Setup

To get started you have to configure your SvelteKit project to use this adapter:

**`svelte.config.js`**

```javascript
import adapter from "@flit/sveltekit-adapter-cdk";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({}),
  },
};
```

Once you have built your SvelteKit project using the new adapter you can now import it from you AWS CDK project as a CDK construct:

```typescript
import { Construct } from "constructs";
import { Stack } from "aws-cdk-lib";
import { RuntimeFamily } from "aws-cdk-lib/aws-lambda";
import {
  ARecord,
  PublicHostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { LambdaPowertoolsLayer } from "cdk-aws-lambda-powertools-layer";

import { SvelteKit } from "your-sveltekit-project";

export class ExampleStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const hostedZone = PublicHostedZone.fromPublicHostedZoneAttributes(
      this,
      "HostedZone",
      {
        zoneName: "...",
        hostedZoneId: "...",
      },
    );

    const powertools = new LambdaPowertoolsLayer(this, "Powertools", {
      runtimeFamily: RuntimeFamily.NODEJS,
      includeExtras: false,
    });

    const svelteKit = new SvelteKit(this, "SvelteKit", {
      layers: [powertools],
      bundling: {
        minify: true,
        sourcesContent: false,
        externalModules: ["@aws-sdk", "@aws-lambda-powertools"],
      },
      environment: {
        POWERTOOLS_SERVICE_NAME: "example-service",
      },
    });

    new ARecord(this, "ARecord", {
      recordName: "example.com",
      zone: hostedZone,
      target: RecordTarget.fromAlias(
        new CloudFrontTarget(svelteKit.cloudFront),
      ),
    });
  }
}
```

This adapter currently only supports one architecture configuration, uses a cloud front instance to server pre-rendered pages from a S3 bucket and and dynamic content from a NodeJS lambda function which you can configure trough the construct parameters.

If you would like to see any other infrastructure configurations please open a issue and feel free to contribute!
