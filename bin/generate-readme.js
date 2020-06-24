#!/usr/bin/env node
// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const chalk = require('chalk');
const { request, Gaxios } = require('gaxios');
const figures = require('figures');
const { readFileSync, writeFileSync } = require('fs');
const parseLinkHeader = require('parse-link-header');

const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error('Please include a GITHUB_TOKEN env var.');
}
const baseUrl = 'https://api.github.com';
const github = new Gaxios({
  headers: {
    authorization: `token ${token}`
  }
});

function checkpoint (message, success = true) {
  const prefix = success ? chalk.green(figures.tick) : chalk.red(figures.cross);
  console.info(`${prefix} ${message}`);
}

async function collectRepoMetadata (repos) {
  const repoMetadata = {};
  for (const repo of repos) {
    try {
      const url = `${baseUrl}/repos/${repo}/contents/.repo-metadata.json`;
      const res = await github.request({ url });
      repoMetadata[repo] = JSON.parse(
        Buffer.from(res.data.content, 'base64').toString('utf8')
      );
      checkpoint(`${repo} found .repo-metadata.json`);
    } catch (err) {
      if (!err.response || err.response.status !== 404) {
        throw err;
      }
      checkpoint(`${repo} had no .repo-metadata.json`, false);
    }
  }
  return repoMetadata;
}

// Fills in README.mustache with contents loaded from sloth/repos.json.
// Given the simplicity of the template, we do not actually use a templating
// engine, instead calling string.replace.
async function generateReadme (repoMetadata) {
  const template = readFileSync('./bin/README.mustache', 'utf8');
  const libraries = [];

  // filter libraries to only contain those with Google Cloud api_id,
  // standardizing naming along the way.
  for (const repoMetadataKey in repoMetadata) {
    const metadata = repoMetadata[repoMetadataKey];

    if (!metadata.api_id) {
      continue;
    }

    // making naming more consistent, sometimes we've appended Cloud,
    // sometimes Google Cloud.
    metadata.name_pretty = metadata.name_pretty.replace(/^(Google )?Cloud /, '');

    if (metadata.product_documentation) {
      // add a link to the "Getting Support" page on the docs
      // examples:
      //     input: https://cloud.google.com/container-registry/docs/container-analysis
      //     output: https://cloud.google.com/container-registry/docs/getting-support
      //     input: https://cloud.google.com/natural-language/docs/
      //     output: https://cloud.google.com/natural-language/docs/getting-support
      let supportDocsUrl = metadata.product_documentation
        // guarantee trailing /
        .replace(/\/*$/, '/')
        // append "docs/getting-support" path, if not already there
        // this also strips anything else found after "docs/"
        .replace(/(docs\/(.+)*)*$/, 'docs/getting-support');

      // multiple product docs point to the same docs page
      if (metadata.name_pretty.toLowerCase().trim().startsWith('stackdriver')) {
        supportDocsUrl = 'https://cloud.google.com/stackdriver/docs/getting-support';
      }

      // if URL doesn't exist, fall back to the generic docs page
      const res = await request({
        url: supportDocsUrl,
        method: 'HEAD',
        validateStatus: () => true
      });
      const remoteUrlExists = res.status !== 404;
      if (!remoteUrlExists) {
        supportDocsUrl = metadata.product_documentation;
      }
      metadata.support_documentation = supportDocsUrl;
    }

    libraries.push(metadata);
  }

  libraries.sort((a, b) => {
    return a.name_pretty.localeCompare(b.name_pretty);
  });
  writeFileSync('./libraries.json', JSON.stringify(libraries, null, 2), 'utf8');

  let partial = '';
  libraries.forEach((lib) => {
    partial += `| [${lib.name_pretty}](https://github.com/${lib.repo}) | [:notebook:](${lib.client_documentation}) | \`npm i ${lib.distribution_name}\` | [enable](https://console.cloud.google.com/flows/enableapi?apiid=${lib.api_id}) | ${lib.requires_billing ? figures.cross : figures.tick} |\n`;
  });

  writeFileSync('./README.md', template.replace('{{libraries}}', partial), 'utf8');
}

async function getRepos () {
  const q = 'nodejs in:.repo-metadata.json org:googleapis is:public archived:false';
  let url = new URL('/search/repositories', baseUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('per_page', 100);
  const repos = [];
  while (url) {
    const res = await github.request({ url: url.href });
    repos.push(...res.data.items.map(r => r.full_name));
    url = null;
    if (res.headers['link']) {
      const link = parseLinkHeader(res.headers['link']);
      if (link.next) {
        url = new URL(link.next.url);
      }
    }
  }
  return repos;
}

async function main () {
  const repos = await getRepos();
  checkpoint(`Discovered ${repos.length} node.js repos with metadata`);
  const repoMetadata = await collectRepoMetadata(repos);
  await generateReadme(repoMetadata);
}
main().catch(console.error);
