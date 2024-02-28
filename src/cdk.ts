import { Construct } from "constructs";
import { Duration, Fn, RemovalPolicy } from "aws-cdk-lib";
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
import { HttpOrigin, S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  HttpMethods,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { BundlingOptions, NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  BucketDeployment,
  CacheControl,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
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
  readonly provisionedConcurrentExecutions?: number;
}

export class SvelteKit extends Construct {
  public readonly lambda: NodejsFunction;
  public readonly alias: Alias;
  public readonly cloudFront: Distribution;

  constructor(scope: Construct, id: string, props: SvelteKitProps) {
    super(scope, id);

    this.lambda = new NodejsFunction(this, "Server", {
      ...props,
      entry: fileURLToPath(new URL("./server/index.js", import.meta.url).href),
      bundling: {
        ...props.bundling,
        mainFields: ["module", "main"],
        esbuildArgs: {
          "--conditions": "module",
        },
      },
    });

    const lambdaVersion = this.lambda.currentVersion;

    this.alias = new Alias(this, "Alias", {
      aliasName: "Prod",
      version: lambdaVersion,
      provisionedConcurrentExecutions: props.provisionedConcurrentExecutions,
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
    });

    new BucketDeployment(this, "ClientBucketDeployment", {
      destinationBucket: clientBucket,
      logRetention: RetentionDays.ONE_DAY,
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
    });

    if (prerendered.size) {
      new BucketDeployment(this, "PrerenderedBucketDeployment", {
        destinationBucket: prerenderedBucket,
        logRetention: RetentionDays.ONE_DAY,
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

    const bucketOrigin = new S3Origin(clientBucket);

    this.cloudFront = new Distribution(this, "CloudFront", {
      domainNames: props.domainNames,
      certificate: props.certificate,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        origin: new HttpOrigin(
          Fn.select(
            2,
            Fn.split(
              "/",
              this.alias.addFunctionUrl({
                authType: FunctionUrlAuthType.NONE,
                invokeMode: InvokeMode.RESPONSE_STREAM,
              }).url,
            ),
          ),
        ),
        functionAssociations: [
          {
            eventType: FunctionEventType.VIEWER_REQUEST,
            function: new Function(this, "XForwardHost", {
              code: FunctionCode.fromInline(`
                function handler(event) {
                  var request = event.request;
                  request.headers['x-forwarded-host'] = {value: request.headers.host.value};
                  return request;
                }`),
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
          origin: bucketOrigin,
        },
      },
    });

    clientBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
      allowedOrigins: [
        ...(props.domainNames || []),
        this.cloudFront.domainName,
      ],
    });

    prerenderedBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
      allowedOrigins: [
        ...(props.domainNames || []),
        this.cloudFront.domainName,
      ],
    });

    manifest.assets.forEach((asset) => {
      if (asset.toLowerCase() === ".ds_store") {
        return;
      }

      this.cloudFront.addBehavior(asset, bucketOrigin, {
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      });
    });
  }
}
