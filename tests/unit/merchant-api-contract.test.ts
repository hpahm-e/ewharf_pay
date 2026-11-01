import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("EWharf OpenAPI contract", () => {
	it("declares exactly the implemented merchant entry routes", async () => {
		const document = await openApi();
		expect(Object.keys(document.paths).sort()).toEqual(
			(await implementedMerchantRoutes()).sort(),
		);
	});

	it("documents JSON/form EWharf input and signed query", async () => {
		const document = await openApi();
		const ewharf = document.paths[
			"/payments/ewharf/v1/order/create-transaction"
		]?.post as Operation;
		expect(Object.keys(ewharf.requestBody.content).sort()).toEqual([
			"application/json",
			"application/x-www-form-urlencoded",
		]);
		expect(ewharf.callbacks?.orderNotification).toBeTruthy();
		const query = document.paths["/payments/ewharf/v1/order/query"]
			?.get as Operation;
		expect(query.parameters?.map((parameter) => parameter.name).sort()).toEqual(
			["order_id", "pid", "signature", "trade_id"],
		);
	});

	it("documents the status contract without a default chain", async () => {
		const document = await openApi();
		const schemas = document.components.schemas;
		const orderStatus = requiredSchema(schemas, "OrderStatus");
		const ewharfStatus = requiredSchema(schemas, "EwharfStatus");
		const createRequest = requiredSchema(schemas, "EwharfCreateRequest");
		const createData = requiredSchema(schemas, "EwharfCreateData");
		const notification = requiredSchema(schemas, "EwharfNotification");
		expect(orderStatus.enum).toEqual([
			"pending",
			"confirming",
			"partially_paid",
			"paid",
			"overpaid",
			"expired",
			"cancelled",
			"failed",
			"refunded",
		]);
		expect(createRequest.properties.token?.default).toBeUndefined();
		expect(createRequest.properties.network?.default).toBeUndefined();
		expect(createRequest.properties.amount?.oneOf).toEqual([
			expect.objectContaining({ type: "string" }),
			expect.objectContaining({ type: "number" }),
		]);
		expect(ewharfStatus.enum).toEqual([1, 2, 3, 4]);
		expect(createData.properties.status).toEqual({
			$ref: "#/components/schemas/EwharfStatus",
		});
		expect(createData.properties.status_detail).toEqual({
			$ref: "#/components/schemas/OrderStatus",
		});
		expect(notification.properties.status?.enum).toEqual([1, 2, 3]);
		expect(createData.properties.amount).toMatchObject({
			type: "string",
		});
		expect(createData.required).toContain("network");
		expect(createData.properties.trade_id).toMatchObject({
			pattern: "^[0-9]{20}$",
		});
		expect(notification.properties.amount).toMatchObject({
			type: "string",
		});
		expect(createRequest.properties.signature).toMatchObject({
			pattern: "^[0-9a-f]{64}$",
		});
		expect(notification.properties.signature).toMatchObject({
			pattern: "^[0-9a-f]{64}$",
		});
		expect(JSON.stringify(document)).toContain("HMAC-SHA256");
		expect(JSON.stringify(document)).not.toContain("X-EWharf-Nonce");
	});

	it("resolves every local OpenAPI reference", async () => {
		const document = await openApi();
		for (const reference of collectReferences(document)) {
			expect(
				resolveReference(document, reference),
				reference,
			).not.toBeUndefined();
		}
	});
});

function requiredSchema(
	schemas: Awaited<ReturnType<typeof openApi>>["components"]["schemas"],
	name: string,
) {
	const schema = schemas[name];
	if (!schema) throw new Error(`Missing OpenAPI schema: ${name}`);
	return schema;
}

function collectReferences(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(collectReferences);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) =>
		key === "$ref"
			? typeof child === "string" && child.startsWith("#/")
				? [child]
				: []
			: collectReferences(child),
	);
}

function resolveReference(document: unknown, reference: string): unknown {
	return reference
		.slice(2)
		.split("/")
		.reduce<unknown>(
			(value, segment) =>
				value && typeof value === "object"
					? (value as Record<string, unknown>)[segment]
					: undefined,
			document,
		);
}

async function implementedMerchantRoutes() {
	const root = resolve(
		new URL("../../src/routes/payments", import.meta.url).pathname,
	);
	const files = await routeFiles(root);
	return files.map((file) => {
		const route = relative(root, file)
			.split(sep)
			.join("/")
			.replace(/\.tsx?$/, "")
			.replaceAll("[.]", ".")
			.replace(/\/index$/, "");
		return `/payments/${route}`;
	});
}

async function routeFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = resolve(directory, entry.name);
			return entry.isDirectory()
				? routeFiles(path)
				: Promise.resolve(/\.tsx?$/.test(entry.name) ? [path] : []);
		}),
	);
	return nested.flat();
}

type Operation = {
	requestBody: { content: Record<string, unknown> };
	responses: Record<string, unknown>;
	parameters?: Array<{ name: string }>;
	callbacks?: Record<string, unknown>;
};

async function openApi() {
	const source = await readFile(
		new URL("../../public/openapi.yaml", import.meta.url),
		"utf8",
	);
	return parse(source) as {
		paths: Record<string, Record<string, unknown>>;
		components: {
			schemas: Record<
				string,
				{
					enum: Array<string | number>;
					required?: string[];
					properties: Record<
						string,
						{
							default?: unknown;
							type?: string;
							pattern?: string;
							$ref?: string;
							enum?: Array<string | number>;
							oneOf?: Array<{ type?: string; pattern?: string }>;
						}
					>;
				}
			>;
		};
	};
}
