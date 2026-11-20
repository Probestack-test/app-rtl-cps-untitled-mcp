import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
process.env.OTEL_SERVICE_NAME ??= 'untitled';
process.env.OTEL_SERVICE_VERSION ??= '1.0.0';
const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
sdk.start();
process.once('beforeExit', () => { void sdk.shutdown(); });
export const tracer = trace.getTracer('untitled', '1.0.0');
