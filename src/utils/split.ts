
export class SentenceSplitter {
    private chunkSize: number = 1024
    private chunkOverlap: number = 200
    private separator: string = ' '
    private paragraphSeparator: string = '\n\n\n'
    private secondaryChunkingRegex: string = '[^,.;。？！]+[,.;。？！]?'

    constructor(params?: {
        chunkSize?: number
        chunkOverlap?: number
        separator?: string
        paragraphSeparator?: string
        secondaryChunkingRegex?: string
    }) {
        if (params) {
            this.chunkSize = params.chunkSize ?? this.chunkSize
            this.chunkOverlap = params.chunkOverlap ?? this.chunkOverlap
            this.separator = params.separator ?? this.separator
            this.paragraphSeparator =
                params.paragraphSeparator ?? this.paragraphSeparator
            this.secondaryChunkingRegex =
                params.secondaryChunkingRegex ?? this.secondaryChunkingRegex
        }
    }

    splitText(text: string): string[] {
        if (text === '') return [text]
        const splits = this.split(text, this.chunkSize)
        return this.merge(splits, this.chunkSize)
    }

    private split(text: string, chunkSize: number): Split[] {
        const tokenSize = this.tokenSize(text)
        if (tokenSize <= chunkSize) {
            return [{ text, isSentence: true, tokenSize }]
        }
        const [textSplitsByFns, isSentence] = this.getSplitsByFns(text)
        const textSplits: Split[] = []

        for (const textSplit of textSplitsByFns) {
            const tokenSize = this.tokenSize(textSplit)
            if (tokenSize <= chunkSize) {
                textSplits.push({ text: textSplit, isSentence, tokenSize })
            } else {
                const recursiveTextSplits = this.split(textSplit, chunkSize)
                textSplits.push(...recursiveTextSplits)
            }
        }
        return textSplits
    }

    private getSplitsByFns(
        text: string
    ): [splits: string[], isSentence: boolean] {
        const paragraphSplits = text.split(this.paragraphSeparator)
        if (paragraphSplits.length > 1) {
            return [paragraphSplits, true]
        }

        const sentenceSplits = text.match(/[^.!?]+[.!?]+/g) || [text]
        if (sentenceSplits.length > 1) {
            return [sentenceSplits, true]
        }

        const subSentenceSplits = text.match(
            new RegExp(this.secondaryChunkingRegex, 'g')
        ) || [text]
        if (subSentenceSplits.length > 1) {
            return [subSentenceSplits, false]
        }

        const wordSplits = text.split(this.separator)
        if (wordSplits.length > 1) {
            return [wordSplits, false]
        }

        return [[text], true]
    }

    private merge(splits: Split[], chunkSize: number): string[] {
        const chunks: string[] = []
        let currentChunk: [string, number][] = []
        let lastChunk: [string, number][] = []
        let currentChunkLength = 0
        let newChunk = true

        const closeChunk = (): void => {
            chunks.push(currentChunk.map(([text]) => text).join(''))
            lastChunk = currentChunk
            currentChunk = []
            currentChunkLength = 0
            newChunk = true

            let lastIndex = lastChunk.length - 1
            while (
                lastIndex >= 0 &&
                currentChunkLength + lastChunk[lastIndex]![1] <= this.chunkOverlap
            ) {
                const [text, length] = lastChunk[lastIndex]!
                currentChunkLength += length
                currentChunk.unshift([text, length])
                lastIndex -= 1
            }
        }

        while (splits.length > 0) {
            const curSplit = splits[0]!
            if (curSplit.tokenSize > chunkSize) {
                throw new Error('Single token exceeded chunk size')
            }
            if (currentChunkLength + curSplit.tokenSize > chunkSize && !newChunk) {
                closeChunk()
            } else {
                if (
                    curSplit.isSentence ||
                    currentChunkLength + curSplit.tokenSize <= chunkSize ||
                    newChunk
                ) {
                    currentChunkLength += curSplit.tokenSize
                    currentChunk.push([curSplit.text, curSplit.tokenSize])
                    splits.shift()
                    newChunk = false
                } else {
                    closeChunk()
                }
            }
        }

        if (!newChunk) {
            chunks.push(currentChunk.map(([text]) => text).join(''))
        }

        return this.postprocessChunks(chunks)
    }

    private postprocessChunks(chunks: string[]): string[] {
        return chunks.map(chunk => chunk.trim()).filter(chunk => chunk !== '')
    }

    private tokenSize(text: string): number {
        return Math.ceil(text.length / 4)
    }
}

export function splitContent(content: string): string[] {
    const splitter = new SentenceSplitter({
        chunkSize: 4096,
        chunkOverlap: 400
    })
    const chunks = splitter.splitText(content)
    return chunks
}
