/* Duo Notes — icon data library for the drawing canvas: shapes only, plus one SVG render helper. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const Icons = (App.Icons = {});

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CHIP_GLYPH = '#fff';
  const DEFAULT_GLYPH = '#2b2620';

  Icons.CATEGORIES = [
    { id: 'aws', name: 'AWS-style' },
    { id: 'uml', name: 'UML' },
    { id: 'infra', name: 'Infrastructure' }
  ];

  // Reusable geometry. All artwork is authored on a 24x24 viewBox, kept inside 2..22.
  const CYL = {
    // Cylinder (database) spanning y1..y2 with half-width rx around cx = 12.
    at(y1, y2, rx) {
      const l = 12 - rx;
      const r = 12 + rx;
      const ry = rx * 0.38;
      return [
        { d: 'M' + l + ' ' + y1 + ' A' + rx + ' ' + ry + ' 0 0 0 ' + r + ' ' + y1 + ' A' + rx + ' ' + ry + ' 0 0 0 ' + l + ' ' + y1, fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M' + l + ' ' + y1 + ' V' + y2 + ' A' + rx + ' ' + ry + ' 0 0 0 ' + r + ' ' + y2 + ' V' + y1, fill: 'none', stroke: 'glyph', sw: 1.6 }
      ];
    }
  };

  function ellipse(cx, cy, rx, ry, sw) {
    const l = cx - rx;
    const r = cx + rx;
    return { d: 'M' + l + ' ' + cy + ' A' + rx + ' ' + ry + ' 0 0 0 ' + r + ' ' + cy + ' A' + rx + ' ' + ry + ' 0 0 0 ' + l + ' ' + cy, fill: 'none', stroke: 'glyph', sw: sw || 1.6 };
  }

  const AWS = [
    {
      id: 'aws.ec2', name: 'EC2', cat: 'aws', color: '#ED7100',
      keywords: 'compute instance server virtual machine vm host',
      paths: [
        { rect: [7, 7, 10, 10, 1], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M9.5 5 V7 M14.5 5 V7 M9.5 17 V19 M14.5 17 V19 M5 9.5 H7 M5 14.5 H7 M17 9.5 H19 M17 14.5 H19', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.lambda', name: 'Lambda', cat: 'aws', color: '#ED7100',
      keywords: 'serverless function faas compute event handler',
      paths: [
        { d: 'M7.5 6 H10.5 L17 18.5', fill: 'none', stroke: 'glyph', sw: 2 },
        { d: 'M13.2 11.6 L9.2 18.5', fill: 'none', stroke: 'glyph', sw: 2 }
      ]
    },
    {
      id: 'aws.ecs', name: 'ECS', cat: 'aws', color: '#ED7100',
      keywords: 'container docker fargate cluster task orchestration',
      paths: [
        { rect: [6, 5.5, 12, 3.8, 0.6], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [6, 10.1, 12, 3.8, 0.6], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [6, 14.7, 12, 3.8, 0.6], fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.s3', name: 'S3', cat: 'aws', color: '#7AA116',
      keywords: 'storage bucket object blob files simple storage service',
      paths: [
        { d: 'M5.5 8 L7.5 19 H16.5 L18.5 8', fill: 'none', stroke: 'glyph', sw: 1.6 },
        ellipse(12, 8, 6.5, 2.1)
      ]
    },
    {
      id: 'aws.efs', name: 'EFS', cat: 'aws', color: '#7AA116',
      keywords: 'elastic file system storage nfs shared volume disk',
      paths: [
        ellipse(12, 7, 6, 2.2),
        ellipse(12, 12, 6, 2.2),
        ellipse(12, 17, 6, 2.2)
      ]
    },
    {
      id: 'aws.rds', name: 'RDS', cat: 'aws', color: '#C925D1',
      keywords: 'relational database sql postgres mysql aurora instance',
      paths: CYL.at(7, 17, 6)
    },
    {
      id: 'aws.dynamodb', name: 'DynamoDB', cat: 'aws', color: '#C925D1',
      keywords: 'nosql key value table document database fast',
      paths: CYL.at(6.5, 17.5, 6).concat([
        { d: 'M13.4 8.6 L9.6 13.6 H12 L10.8 17.4 L14.8 12.2 H12.3 Z', fill: 'glyph', stroke: 'none' }
      ])
    },
    {
      id: 'aws.elasticache', name: 'ElastiCache', cat: 'aws', color: '#C925D1',
      keywords: 'cache redis memcached in memory fast lookup',
      paths: CYL.at(15, 19.3, 5.5).concat([
        { d: 'M13.8 3.6 L9.4 9.6 H12 L10.8 12.6 L15.2 7.4 H12.6 Z', fill: 'glyph', stroke: 'none' }
      ])
    },
    {
      id: 'aws.vpc', name: 'VPC', cat: 'aws', color: '#8C4FFF',
      keywords: 'network virtual private cloud subnet boundary isolation',
      paths: [
        { d: 'M4 8.5 V6 A2 2 0 0 1 6 4 H8.5 M11.5 4 H15.5 M18 4 A2 2 0 0 1 20 6 V8.5 M20 11.5 V15.5 M20 18 A2 2 0 0 1 18 20 H15.5 M12.5 20 H8.5 M6 20 A2 2 0 0 1 4 18 V15.5 M4 12.5 V11.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [9.5, 9.5, 5, 5, 0.8], fill: 'glyph', stroke: 'none' }
      ]
    },
    {
      id: 'aws.cloudfront', name: 'CloudFront', cat: 'aws', color: '#8C4FFF',
      keywords: 'cdn edge global distribution cache delivery network',
      paths: [
        { circle: [12, 12, 7], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M5 12 H19', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 5 A8 8 0 0 0 12 19 A8 8 0 0 0 12 5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.route53', name: 'Route 53', cat: 'aws', color: '#8C4FFF',
      keywords: 'dns domain routing signpost record zone resolver',
      paths: [
        { d: 'M12 4 V20', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { d: 'M12 5.5 H19 L20.5 7.6 L19 9.7 H12 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 12.3 H5 L3.5 14.4 L5 16.5 H12 Z', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.elb', name: 'Load Balancer', cat: 'aws', color: '#8C4FFF',
      keywords: 'elb alb nlb load balancing traffic split fan out routing',
      paths: [
        { d: 'M6 12 H11 M11 12 L16 6.5 M11 12 H16 M11 12 L16 17.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [5, 12, 2], fill: 'glyph', stroke: 'none' },
        { circle: [18, 6.5, 1.8], fill: 'glyph', stroke: 'none' },
        { circle: [18, 12, 1.8], fill: 'glyph', stroke: 'none' },
        { circle: [18, 17.5, 1.8], fill: 'glyph', stroke: 'none' }
      ]
    },
    {
      id: 'aws.apigateway', name: 'API Gateway', cat: 'aws', color: '#8C4FFF',
      keywords: 'api rest http endpoint gateway proxy brackets',
      paths: [
        { d: 'M8.5 5.5 L4.5 12 L8.5 18.5', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { d: 'M15.5 5.5 L19.5 12 L15.5 18.5', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { d: 'M12 6.5 V17.5', fill: 'none', stroke: 'glyph', sw: 1.8 }
      ]
    },
    {
      id: 'aws.sqs', name: 'SQS', cat: 'aws', color: '#E7157B',
      keywords: 'queue message buffer fifo async decouple simple queue service',
      paths: [
        { d: 'M6 7.5 V16.5 M10 7.5 V16.5 M14 7.5 V16.5', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { d: 'M16.5 12 H20 M18.5 10 L20.5 12 L18.5 14', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.sns', name: 'SNS', cat: 'aws', color: '#E7157B',
      keywords: 'notification pubsub topic broadcast push fan out subscribe',
      paths: [
        { circle: [6.5, 12, 2.2], fill: 'glyph', stroke: 'none' },
        { d: 'M11.5 7.5 A7 7 0 0 1 11.5 16.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M15 4.5 A10 10 0 0 1 15 19.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M18.5 6 A13 13 0 0 1 18.5 18', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.eventbridge', name: 'EventBridge', cat: 'aws', color: '#E7157B',
      keywords: 'event bus rule branch trigger cloudwatch events routing',
      paths: [
        { d: 'M3.5 12 H20.5', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { d: 'M8 12 V7 M12 12 V17 M16 12 V7', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [8, 5.8, 1.6], fill: 'glyph', stroke: 'none' },
        { circle: [16, 5.8, 1.6], fill: 'glyph', stroke: 'none' },
        { circle: [12, 18.2, 1.6], fill: 'glyph', stroke: 'none' }
      ]
    },
    {
      id: 'aws.stepfunctions', name: 'Step Functions', cat: 'aws', color: '#E7157B',
      keywords: 'workflow state machine orchestration chain steps saga',
      paths: [
        { rect: [4, 4.5, 8, 5, 1], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [12, 14.5, 8, 5, 1], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M8 9.5 V15 Q8 17 10 17 H12', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'aws.cognito', name: 'Cognito', cat: 'aws', color: '#DD344C',
      keywords: 'auth identity user pool login signin authentication verified',
      paths: [
        { circle: [9, 7.8, 2.6], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M3.8 18.5 C3.8 13.4 14.2 13.4 14.2 18.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M14.6 13.2 L17 15.6 L20.8 10.8', fill: 'none', stroke: 'glyph', sw: 1.8 }
      ]
    },
    {
      id: 'aws.secretsmanager', name: 'Secrets Manager', cat: 'aws', color: '#DD344C',
      keywords: 'secret password credential vault padlock rotation kms',
      paths: [
        { d: 'M8.5 11 V8.5 A3.5 3.5 0 0 1 15.5 8.5 V11', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [6, 11, 12, 8.5, 1.5], fill: 'glyph', stroke: 'none' },
        { circle: [12, 15.2, 1.5], fill: '#DD344C', stroke: 'none' }
      ]
    },
    {
      id: 'aws.cloudwatch', name: 'CloudWatch', cat: 'aws', color: '#E7157B',
      keywords: 'monitoring metrics logs alarm gauge observability dashboard',
      paths: [
        { d: 'M4.5 16.5 A7.8 7.8 0 1 1 19.5 16.5', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { d: 'M12 16.5 L15.8 10.5', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { circle: [12, 16.5, 1.6], fill: 'glyph', stroke: 'none' }
      ]
    }
  ];

  const UML = [
    {
      id: 'uml.actor', name: 'Actor', cat: 'uml',
      keywords: 'stick figure person user role external',
      paths: [
        { circle: [12, 6, 2.6], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 8.6 V15 M7.5 11 H16.5 M12 15 L8 20.5 M12 15 L16 20.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'uml.package', name: 'Package', cat: 'uml',
      keywords: 'namespace module folder tab grouping',
      paths: [
        { d: 'M3.5 6 H9.5 V8.5 H20.5 V19 H3.5 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M3.5 8.5 H9.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'uml.component', name: 'Component', cat: 'uml',
      keywords: 'module service block tabs subsystem',
      paths: [
        { rect: [7, 5, 13, 14, 0.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [4, 8, 6, 3, 0.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [4, 13, 6, 3, 0.5], fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'uml.interface', name: 'Interface', cat: 'uml',
      keywords: 'lollipop provided contract port api',
      paths: [
        { d: 'M3.5 12 H13.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [17, 12, 3.4], fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'uml.note', name: 'Note', cat: 'uml',
      keywords: 'comment annotation folded corner remark',
      paths: [
        { d: 'M4.5 4.5 H15.5 L19.5 8.5 V19.5 H4.5 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M15.5 4.5 V8.5 H19.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'uml.usecase', name: 'Use case', cat: 'uml',
      keywords: 'ellipse oval scenario behaviour goal',
      paths: [ellipse(12, 12, 8.5, 5)]
    },
    {
      id: 'uml.state', name: 'State', cat: 'uml',
      keywords: 'rounded rectangle status machine activity node',
      paths: [{ rect: [3.5, 7, 17, 10, 5], fill: 'none', stroke: 'glyph', sw: 1.6 }]
    },
    {
      id: 'uml.artifact', name: 'Artifact', cat: 'uml',
      keywords: 'document deliverable file folded corner deployment',
      paths: [
        { d: 'M6 3.5 H14 L18 7.5 V20.5 H6 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M14 3.5 V7.5 H18', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M8.5 12 H15.5 M8.5 15.5 H15.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    }
  ];

  const INFRA = [
    {
      id: 'infra.server', name: 'Server', cat: 'infra',
      keywords: 'rack host machine node hardware box',
      paths: [
        { rect: [4, 5, 16, 5.5, 1], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [4, 13.5, 16, 5.5, 1], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [7.2, 7.7, 1.1], fill: 'glyph', stroke: 'none' },
        { circle: [7.2, 16.2, 1.1], fill: 'glyph', stroke: 'none' }
      ]
    },
    {
      id: 'infra.database', name: 'Database', cat: 'infra',
      keywords: 'db store sql cylinder persistence table',
      paths: CYL.at(7, 17, 6)
    },
    {
      id: 'infra.queue', name: 'Queue', cat: 'infra',
      keywords: 'message broker pipeline buffer jobs backlog',
      paths: [
        { rect: [3.5, 9, 4.6, 6, 0.8], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [9.7, 9, 4.6, 6, 0.8], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [15.9, 9, 4.6, 6, 0.8], fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.cloud', name: 'Cloud', cat: 'infra',
      keywords: 'saas hosted internet provider region external',
      paths: [
        { d: 'M6.8 17.5 H17.4 A3.6 3.6 0 0 0 16.6 10.5 A5.2 5.2 0 0 0 7.2 11.4 A3.2 3.2 0 0 0 6.8 17.5 Z', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.user', name: 'User', cat: 'infra',
      keywords: 'person account customer profile actor human',
      paths: [
        { circle: [12, 8.5, 3.4], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M5 19.5 C5 13.8 19 13.8 19 19.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.users', name: 'Users', cat: 'infra',
      keywords: 'group team people audience accounts many',
      paths: [
        { circle: [9.5, 9, 3], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M3.5 19 C3.5 14 15.5 14 15.5 19', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [17, 8, 2.2], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M16.5 12.5 C19.8 13 20.5 16 20.5 18.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.browser', name: 'Browser', cat: 'infra',
      keywords: 'web page window chrome frontend client spa',
      paths: [
        { rect: [3.5, 5, 17, 14, 1.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M3.5 9.5 H20.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [6.3, 7.3, 0.9], fill: 'glyph', stroke: 'none' },
        { circle: [9, 7.3, 0.9], fill: 'glyph', stroke: 'none' },
        { circle: [11.7, 7.3, 0.9], fill: 'glyph', stroke: 'none' }
      ]
    },
    {
      id: 'infra.mobile', name: 'Mobile', cat: 'infra',
      keywords: 'phone app ios android handset device client',
      paths: [
        { rect: [7.5, 3, 9, 18, 2], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M10.5 18.3 H13.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.laptop', name: 'Laptop', cat: 'infra',
      keywords: 'computer desktop workstation developer machine client',
      paths: [
        { rect: [5, 4.6, 14, 10.6, 1], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M4 15.2 H20 L21.5 18.6 H2.5 Z', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.globe', name: 'Globe', cat: 'infra',
      keywords: 'world internet global public dns region www',
      paths: [
        { circle: [12, 12, 8.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M3.5 12 H20.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 3.5 A10 10 0 0 0 12 20.5 A10 10 0 0 0 12 3.5', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.lock', name: 'Lock', cat: 'infra',
      keywords: 'secure padlock private encrypted tls auth closed',
      paths: [
        { d: 'M8.5 11 V8.5 A3.5 3.5 0 0 1 15.5 8.5 V11', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { rect: [5, 11, 14, 9, 1.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 14 V17', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.key', name: 'Key', cat: 'infra',
      keywords: 'credential token access secret api key unlock',
      paths: [
        { circle: [8, 8, 3.6], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M10.6 10.6 L19 19', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M14.4 14.4 L16.8 12 M16.6 16.6 L19 14.2', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.gear', name: 'Gear', cat: 'infra',
      keywords: 'settings config process worker job automation cog',
      paths: [
        { circle: [12, 12, 4.6], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { circle: [12, 12, 1.7], fill: 'none', stroke: 'glyph', sw: 1.6 },
        // Teeth start on the circle (radius 4) and reach radius 7, so they read as gear teeth, not rays.
        { d: 'M12 8 V5 M12 16 V19 M8 12 H5 M16 12 H19 M9.2 9.2 L7.1 7.1 M14.8 14.8 L16.9 16.9 M14.8 9.2 L16.9 7.1 M9.2 14.8 L7.1 16.9', fill: 'none', stroke: 'glyph', sw: 2.4 }
      ]
    },
    {
      id: 'infra.folder', name: 'Folder', cat: 'infra',
      keywords: 'directory group bucket files tree path',
      paths: [
        { d: 'M3.5 18.5 V6.5 H9.2 L11.2 9 H20.5 V18.5 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M3.5 9 H11.2', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.file', name: 'File', cat: 'infra',
      keywords: 'document object blob record data page',
      paths: [
        { d: 'M6 3.5 H14 L18 7.5 V20.5 H6 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M14 3.5 V7.5 H18', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.mail', name: 'Mail', cat: 'infra',
      keywords: 'email envelope smtp message notification send',
      paths: [
        { rect: [3.5, 6, 17, 12, 1.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M4 7 L12 13.2 L20 7', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.clock', name: 'Clock', cat: 'infra',
      keywords: 'time schedule cron delay timeout latency timer',
      paths: [
        { circle: [12, 12, 8.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 6.5 V12 L15.8 14.8', fill: 'none', stroke: 'glyph', sw: 1.6 }
      ]
    },
    {
      id: 'infra.chart', name: 'Chart', cat: 'infra',
      keywords: 'metrics analytics graph report bars dashboard stats',
      paths: [
        { d: 'M3.5 20 H20.5', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M7 20 V13 M12 20 V7.5 M17 20 V10.5', fill: 'none', stroke: 'glyph', sw: 2.6 }
      ]
    },
    {
      id: 'infra.alert', name: 'Alert', cat: 'infra',
      keywords: 'warning error incident alarm attention failure risk',
      paths: [
        { d: 'M12 3.8 L21 19.6 H3 Z', fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M12 9.5 V14', fill: 'none', stroke: 'glyph', sw: 1.8 },
        { circle: [12, 16.8, 1], fill: 'glyph', stroke: 'none' }
      ]
    },
    {
      id: 'infra.check', name: 'Check', cat: 'infra',
      keywords: 'success ok done healthy pass verified tick',
      paths: [
        { circle: [12, 12, 8.5], fill: 'none', stroke: 'glyph', sw: 1.6 },
        { d: 'M7.5 12.4 L11 15.9 L16.5 8.6', fill: 'none', stroke: 'glyph', sw: 1.8 }
      ]
    }
  ];

  Icons.LIST = AWS.concat(UML, INFRA);

  const BY_ID = new Map(Icons.LIST.map((icon) => [icon.id, icon]));

  Icons.byId = (id) => BY_ID.get(id);

  Icons.all = () => Icons.LIST;

  Icons.search = function (query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return Icons.LIST;
    return Icons.LIST.filter((icon) =>
      icon.id.toLowerCase().includes(q) ||
      icon.name.toLowerCase().includes(q) ||
      icon.keywords.includes(q)
    );
  };

  // ---------- rendering ----------

  function el(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) {
      if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, String(attrs[key]));
    }
    return node;
  }

  function paint(value, glyph) {
    return value === 'glyph' ? glyph : value;
  }

  function shapeNode(entry, glyph) {
    const common = {
      fill: paint(entry.fill === undefined ? 'none' : entry.fill, glyph),
      stroke: paint(entry.stroke === undefined ? 'none' : entry.stroke, glyph),
      'stroke-width': entry.sw
    };
    if (entry.circle) {
      const c = entry.circle;
      return el('circle', Object.assign({ cx: c[0], cy: c[1], r: c[2] }, common));
    }
    if (entry.rect) {
      const r = entry.rect;
      return el('rect', Object.assign({ x: r[0], y: r[1], width: r[2], height: r[3], rx: r[4] }, common));
    }
    return el('path', Object.assign({ d: entry.d }, common));
  }

  function placeholder() {
    const g = el('g', { fill: 'none', stroke: 'none' });
    g.appendChild(el('rect', {
      x: 3, y: 3, width: 18, height: 18, rx: 3,
      fill: 'none', stroke: '#a6998a', 'stroke-width': 1.4, 'stroke-dasharray': '3 2.5'
    }));
    const text = el('text', {
      x: 12, y: 16.5, 'text-anchor': 'middle', 'font-size': 11,
      'font-family': 'inherit', fill: '#a6998a', stroke: 'none'
    });
    text.textContent = '?';
    g.appendChild(text);
    return g;
  }

  Icons.nodeFor = function (iconId, glyphColor) {
    const icon = BY_ID.get(iconId);
    if (!icon) return placeholder();

    const isAws = icon.cat === 'aws';
    const glyph = isAws ? CHIP_GLYPH : glyphColor || DEFAULT_GLYPH;
    const g = el('g', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });

    if (isAws) {
      g.appendChild(el('rect', {
        x: 2, y: 2, width: 20, height: 20, rx: 4,
        fill: icon.color, stroke: 'none'
      }));
    }
    for (const entry of icon.paths) g.appendChild(shapeNode(entry, glyph));
    return g;
  };
})();
