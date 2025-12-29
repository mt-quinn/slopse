export type MedalTimes = { bronzeMs: number; silverMs: number; goldMs: number }

// Editor validation uses a “suggested medals” derivation from the author time.
export const deriveMedalsFromAuthorTime = (authorMs: number): MedalTimes => {
  const roundUpTenth = (ms: number) => Math.ceil(ms / 100) * 100
  // Spec:
  // - gold: author time rounded UP to nearest 0.1s
  // - silver: gold * 1.05
  // - bronze: gold * 1.10
  const gold = roundUpTenth(authorMs)
  const silver = roundUpTenth(gold * 1.05)
  const bronze = roundUpTenth(gold * 1.1)
  return { bronzeMs: bronze, silverMs: silver, goldMs: gold }
}


