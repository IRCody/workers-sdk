import { logRaw } from "@cloudflare/cli";
import { ImageRegistriesService } from "../client";
import { handleFailure } from "../common";
import type { Config } from "../../config";
import type {
	CommonYargsArgvJSON,
	CommonYargsArgvSanitizedJSON,
	StrictYargsOptionsToInterfaceJSON,
} from "../../yargs-types";
import type { ImageRegistryPermissions } from "../client";

// cloudflare managed registry
const domain = "registry.cloudchamber.cfdata.org";

interface CatalogResponse {
	repositories: string[];
}

interface TagsResponse {
	name: string;
	tags: string[];
}

export const imagesCommand = (yargs: CommonYargsArgvJSON) => {
	return yargs
		.command(
			"list",
			"perform operations on images in your cloudchamber registry",
			(args) => listImagesYargs(args),
			(args) =>
				handleFailure(async (_args: CommonYargsArgvSanitizedJSON, config) => {
					await handleListImagesCommand(args, config);
				})(args)
		)
		.command(
			"delete [image:[tag]]",
			"remove an image from your cloudchamber registry",
			(args) => deleteImageYargs(args),
			(args) =>
				handleFailure(async (args: CommonYargsArgvSanitizedJSON, config) => {
					await handleDeleteImageCommand(args, config);
				})(args)
		);
};

function deleteImageYargs(yargs: CommonYargsArgvJSON) {
	return yargs.positional("image", {
		type: "string",
		description: "image to delete",
	});
}

function listImagesYargs(yargs: CommonYargsArgvJSON) {
	return yargs.option("filter", {
		type: "string",
		description: "regex to filter results",
	});
}

async function handleDeleteImageCommand(
	args: StrictYargsOptionsToInterfaceJSON<typeof deleteImagesYargs>,
	_config: Config
) {
	try {
		return await getCreds().then(async (creds) => {
			url = new URL(`https://${domain}`);
			const baseUrl = `${url.protocol}//${url.host}`;
			// if the user gives us a specific tag just delete that one
			if (args.image.includes(":")) {
				const [image, tag] = args.image.split(":");
				try {
					await deleteTag(basUrl, image, tag, creds);
				} catch (error) {
					logRaw(`Error when deleting tag: ${error}`);
				}
			} else {
				const tagsUrl = `${baseUrl}/v2/${args.image}/tags/list`;
				const tagsResponse = await fetch(tagsUrl, {
					method: "GET",
					headers: {
						Authorization: `Basic ${creds}`,
					},
				});

				if (!tagsResponse.ok) {
					throw new Error(
						`Failed to fetch tags : ${tagsResponse.status} ${tagsResponse.statusText}`
					);
				}

				const tagsData = (await tagsResponse.json()) as TagsResponse;
				const tags = tagsData.tags || [];
				if (tags.length === 0) {
					logRaw("No tags found for image.");
					return;
				}
				// For every tag retrieve the manfiest digest then delete the manifest
				for (const tag of tags) {
					try {
						await deleteTag(baseUrl, image, tag, creds);
					} catch (error) {
						logRaw(`Error when deleting tag: ${error}`);
					}
				}
			}
			// trigger gc
			const gcUrl = `${baseUrl}/v2/gc/manifests`;
			gcResponse = await fetch(gcUrl, {
				method: "PUT",
				headers: {
					Authorization: `Basic ${creds}`,
					"Content-Type": "application/json",
				},
			});

			if (!gcResponse.ok) {
				logRaw(
					`Failed to delete image ${args.image}: ${gcResponse.status} ${gcResponse.statusText}`
				);
			}
			logRaw(`Deleted image ${args.image}`);
		});
	} catch (error) {
		logRaw(`Error when removing image: ${error}`);
	}
}

async function handleListImagesCommand(
	args: StrictYargsOptionsToInterfaceJSON<typeof listImagesYargs>,
	_config: Config
) {
	try {
		const creds = await getCreds();
		const repos = await listRepos(creds);
		for (const repo of repos) {
			const stripped = repo.replace(/^\/+/, "");
			const regex = new RegExp(args.filter);
			if (regex.test(stripped)) {
				// get all tags for repo
				const tags = await listTags(stripped, creds);
				const tagline = tags
					.filter((word) => !word.startsWith("sha256"))
					.join();
				logRaw(stripped + " " + tagline);
			}
		}
	} catch (error) {
		logRaw(`Error listing images: ${error}`);
	}
}

async function listTags(repo: string, creds: string): Promise<string[]> {
	url = new URL(`https://${domain}`);
	const baseUrl = `${url.protocol}//${url.host}`;
	const tagsUrl = `${baseUrl}/v2/${repo}/tags/list`;

	const tagsResponse = await fetch(tagsUrl, {
		method: "GET",
		headers: {
			Authorization: `Basic ${creds}`,
		},
	});
	const tagsData = (await tagsResponse.json()) as TagsResponse;
	return tagsData.tags || [];
}

async function listRepos(creds: string): Promise<string[]> {
	url = new URL(`https://${domain}`);

	const catalogUrl = `${url.protocol}//${url.host}/v2/_catalog`;

	const response = await fetch(catalogUrl, {
		method: "GET",
		headers: {
			Authorization: `Basic ${creds}`,
		},
	});
	if (!response.ok) {
		throw new Error(
			`Failed to fetch repository catalog: ${response.status} ${response.statusText}`
		);
	}

	const data = (await response.json()) as CatalogResponse;

	return data.repositories || [];
}

async function deleteTag(
	baseUrl: string,
	image: string,
	tag: string,
	creds: string
) {
	const manifestAcceptHeader =
		"application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
	const manifestUrl = `${baseUrl}/v2/${args.image}/manifests/${tag}`;
	// grab the digest for this tag
	const headResponse = await fetch(manifestUrl, {
		method: "HEAD",
		headers: {
			Authorization: `Basic ${creds}`,
			Accept: manifestAcceptHeader,
		},
	});
	if (!headResponse.ok) {
		throw new Error(
			`failed to retrieve tag info for ${tag}: ${headResponse.status} ${headResponse.statusText}`
		);
	}

	const digest = headResponse.headers.get("Docker-Content-Digest");
	if (!digest) {
		throw new Error(`Digest not found for tag "${tag}".`);
	}

	deleteUrl = `${baseUrl}/v2/${args.image}/manifests/${digest}`;
	deleteResponse = await fetch(deleteUrl, {
		method: "DELETE",
		headers: {
			Authorization: `Basic ${creds}`,
			Accept: manifestAcceptHeader,
		},
	});

	if (!deleteResponse.ok) {
		throw new Error(
			`Failed to delete tag "${tag}" (digest: ${digest}): ${deleteResponse.status} ${deleteResponse.statusText}`
		);
	}
	logRaw(`Deleted tag "${tag}" (digest: ${digest}) for image ${args.image}`);
}

async function getCreds(): Promise<string> {
	return await ImageRegistriesService.generateImageRegistryCredentials(domain, {
		expiration_minutes: 5,
		permissions: ["pull", "push"] as ImageRegistryPermissions[],
	}).then(async (credentials) => {
		return Buffer.from(`v1:${credentials.password}`).toString("base64");
	});
}
