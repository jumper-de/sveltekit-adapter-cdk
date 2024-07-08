import { Construct } from "constructs";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  Distribution,
  ViewerProtocolPolicy,
  OriginRequestPolicy,
  AllowedMethods,
  CachePolicy,
  HttpVersion,
  FunctionEventType,
  FunctionCode,
  Function,
  LambdaEdgeEventType,
} from "aws-cdk-lib/aws-cloudfront";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  FunctionUrlOrigin,
  S3Origin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  HttpMethods,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import {
  BundlingOptions,
  NodejsFunction,
  OutputFormat,
} from "aws-cdk-lib/aws-lambda-nodejs";
import {
  BucketDeployment,
  CacheControl,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import {
  Code,
  FunctionOptions,
  FunctionUrlAuthType,
  InvokeMode,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { fileURLToPath } from "url";
import { EdgeFunction } from "aws-cdk-lib/aws-cloudfront/lib/experimental";

import { manifest, prerendered } from "MANIFEST_DEST";

export interface SvelteKitProps extends FunctionOptions {
  readonly domainNames?: Array<string>;
  readonly certificate?: ICertificate;
  readonly runtime?: Runtime;
  readonly awsSdkConnectionReuse?: boolean;
  readonly depsLockFilePath?: string;
  readonly bundling?: BundlingOptions;
  readonly projectRoot?: string;
}

export class SvelteKit extends Construct {
  public readonly lambda: NodejsFunction;
  public readonly cloudFront: Distribution;

  constructor(scope: Construct, id: string, props: SvelteKitProps) {
    super(scope, id);

    this.lambda = new NodejsFunction(this, "Server", {
      ...props,
      entry: fileURLToPath(
        new URL(
          props.bundling?.format === OutputFormat.ESM
            ? "./server/index.esm.js"
            : "./server/index.cjs.js",
          import.meta.url,
        ).href,
      ),
      bundling: {
        ...props.bundling,
        mainFields: ["module", "main"],
        esbuildArgs: {
          "--conditions": "module",
        },
      },
    });

    const clientBucket = new Bucket(this, "ClientBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      websiteIndexDocument: "index.html",
      publicReadAccess: true,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: ["*"],
        },
      ],
    });

    new BucketDeployment(this, "ClientBucketDeployment", {
      destinationBucket: clientBucket,
      accessControl: BucketAccessControl.PUBLIC_READ,
      sources: [
        Source.asset(fileURLToPath(new URL("./client", import.meta.url).href)),
      ],
      cacheControl: [
        CacheControl.setPublic(),
        CacheControl.maxAge(Duration.days(2)),
        CacheControl.sMaxAge(Duration.days(2)),
        CacheControl.fromString("immutable"),
      ],
    });

    const prerenderedBucket = new Bucket(this, "PrerenderedBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      websiteIndexDocument: "index.html",
      publicReadAccess: true,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: ["*"],
        },
      ],
    });

    if (prerendered.size) {
      new BucketDeployment(this, "PrerenderedBucketDeployment", {
        destinationBucket: prerenderedBucket,
        accessControl: BucketAccessControl.PUBLIC_READ,
        sources: [
          Source.asset(
            fileURLToPath(new URL("./prerendered", import.meta.url).href),
          ),
        ],
        cacheControl: [
          CacheControl.setPublic(),
          CacheControl.maxAge(Duration.minutes(2)),
          CacheControl.sMaxAge(Duration.minutes(2)),
        ],
      });
    }

    const clientBucketOrigin = new S3Origin(clientBucket);
    const prerenderedBucketOrigin = new S3Origin(prerenderedBucket);

    this.cloudFront = new Distribution(this, "CloudFront", {
      domainNames: props.domainNames,
      certificate: props.certificate,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        origin: new FunctionUrlOrigin(
          this.lambda.addFunctionUrl({
            authType: FunctionUrlAuthType.AWS_IAM,
            invokeMode: InvokeMode.RESPONSE_STREAM,
          }),
        ),
        edgeLambdas: [
          {
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: new EdgeFunction(this, "EdgeFunction", {
              handler: "index.handler",
              runtime: Runtime.NODEJS_LATEST,
              code: Code.fromInline(`
                import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
                import { HttpRequest } from "@aws-sdk/protocol-http";
                import { SignatureV4 } from "@aws-sdk/signature-v4";
                import { createHash, createHmac } from "node:crypto";

                function Sha256(secret) {
                  return secret ? createHmac("sha256", secret) : createHash("sha256");
                }

                const credentialProvider = fromNodeProviderChain();
                const credentials = await credentialProvider();

                export async function handler(event) {
                  const request = event.Records[0].cf.request;

                  let headers = request.headers;
                  delete headers["x-forwarded-for"];

                  const hostname = request.headers["host"][0].value;
                  const path =
                    request.uri + (request.querystring ? "?" + request.querystring : "");

                  const req = new HttpRequest({
                    hostname,
                    path,
                    body:
                      request.body && request.body.data
                        ? Buffer.from(request.body.data, request.body.encoding)
                        : undefined,
                    method: request.method,
                  });
                  for (const header of Object.values(headers)) {
                    req.headers[header[0].key] = header[0].value;
                  }
                  req.headers["x-forwarded-host"] = request.headers["host"][0].value;

                  const signer = new SignatureV4({
                    credentials,
                    region: "eu-central-1",
                    service: "lambda",
                    sha256: Sha256,
                  });

                  const signedRequest = await signer.sign(req);

                  for (const header in signedRequest.headers) {
                    request.headers[header.toLowerCase()] = [
                      {
                        key: header,
                        value: signedRequest.headers[header].toString(),
                      },
                    ];
                  }
                  return request;
                }
              `),
            }),
          },
        ],
      },
      additionalBehaviors: {
        "_app/*": {
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          originRequestPolicy:
            OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          origin: clientBucketOrigin,
        },
      },
    });

    manifest.assets.forEach((asset) => {
      if (asset.toLowerCase() !== ".ds_store") {
        this.cloudFront.addBehavior(asset, clientBucketOrigin, {
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          originRequestPolicy:
            OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        });
      }
    });

    prerendered.forEach((asset) => {
      this.cloudFront.addBehavior(
        asset.replace("/index.html", ""),
        prerenderedBucketOrigin,
        {
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          originRequestPolicy:
            OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        },
      );
    });
  }
}
