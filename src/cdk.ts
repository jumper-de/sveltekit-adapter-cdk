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
} from "aws-cdk-lib/aws-cloudfront";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  FunctionUrlOrigin,
  S3StaticWebsiteOrigin,
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
  Alias,
  FunctionOptions,
  FunctionUrlAuthType,
  InvokeMode,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { fileURLToPath } from "url";

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
  public readonly function: NodejsFunction;
  public readonly functionAlias: Alias;
  public readonly cloudFront: Distribution;

  constructor(scope: Construct, id: string, props: SvelteKitProps) {
    super(scope, id);

    this.function = new NodejsFunction(this, "Server", {
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

    const version = this.function.currentVersion;
    this.functionAlias = new Alias(this, "Alias", {
      aliasName: "live",
      version,
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

    const clientBucketOrigin = new S3StaticWebsiteOrigin(clientBucket);
    const prerenderedBucketOrigin = new S3StaticWebsiteOrigin(
      prerenderedBucket,
    );

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
          this.functionAlias.addFunctionUrl({
            authType: FunctionUrlAuthType.NONE,
            invokeMode: InvokeMode.RESPONSE_STREAM,
          }),
        ),
        functionAssociations: [
          {
            eventType: FunctionEventType.VIEWER_REQUEST,
            function: new Function(this, "XForwardHost", {
              code: FunctionCode.fromInline(`
                function handler(event) {
                  var request = event.request;
                  request.headers["x-forwarded-host"] = { value: request.headers.host.value };
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
