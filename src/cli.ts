#!/usr/bin/env bun

import { greet } from './index.ts'

function main() {
  const name = process.argv[2] || 'World'
  console.log(greet(name))
}

main()
