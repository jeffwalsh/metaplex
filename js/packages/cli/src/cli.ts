#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { program } from 'commander';
import * as anchor from '@project-serum/anchor';
import BN from 'bn.js';
import { MintLayout, Token } from '@solana/spl-token';

import { sendTransactionWithRetryWithKeypair, fromUTF8Array } from './helper';
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';

const CACHE_PATH = './.cache';

const DEFAULT_CACHE_NAME = 'temp';

const MAINNET_CLUSTER_URL = 'https://api.mainnet-beta.solana.com/';
const DEVNET_CLUSTER_URL = 'https://api.devnet.solana.com/';
const TESTNET_CLUSTER_URL = 'https://api.testnet.solana.com/';

const DEFAULT_CLUSTER_URL = DEVNET_CLUSTER_URL;

const PAYMENT_WALLET = new anchor.web3.PublicKey(
  'HvwC9QSAzvGXhhVrgPmauVwFWcYZhne3hVot9EbHuFTm',
);

const CANDY_MACHINE = 'candy_machine';

const programId = new anchor.web3.PublicKey(
  'cndyAnrLdpjq1Ssp1z8xxDsB8dxe7u4HL5Nxi2K5WXZ',
);
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
const getTokenWallet = async function (wallet: PublicKey, mint: PublicKey) {
  return (
    await PublicKey.findProgramAddress(
      [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    )
  )[0];
};

export function createAssociatedTokenAccountInstruction(
  associatedTokenAddress: PublicKey,
  payer: PublicKey,
  walletAddress: PublicKey,
  splTokenMintAddress: PublicKey,
) {
  const keys = [
    {
      pubkey: payer,
      isSigner: true,
      isWritable: true,
    },
    {
      pubkey: associatedTokenAddress,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: walletAddress,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: splTokenMintAddress,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: SYSVAR_RENT_PUBKEY,
      isSigner: false,
      isWritable: false,
    },
  ];
  return new TransactionInstruction({
    keys,
    programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    data: Buffer.from([]),
  });
}

function chunks(array, size) {
  return Array.apply(0, new Array(Math.ceil(array.length / size))).map(
    (_, index) => array.slice(index * size, (index + 1) * size),
  );
}

const configArrayStart =
  32 + // authority
  4 +
  6 + // uuid + u32 len
  4 +
  10 + // u32 len + symbol
  2 + // seller fee basis points
  1 +
  4 +
  5 * 34 + // optional + u32 len + actual vec
  8 + //max supply
  1 + //is mutable
  1 + // retain authority
  4; // max number of lines;
const configLineSize = 4 + 32 + 4 + 200;
program.version('0.0.1');

if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH);
}

const getCandyMachine = async (config: anchor.web3.PublicKey, uuid: string) => {
  return await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from(CANDY_MACHINE), config.toBuffer(), Buffer.from(uuid)],
    programId,
  );
};

const getConfig = async (authority: anchor.web3.PublicKey, uuid: string) => {
  return await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from(CANDY_MACHINE), authority.toBuffer(), Buffer.from(uuid)],
    programId,
  );
};

const getMetadata = async (
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

const getMasterEdition = async (
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
        Buffer.from('edition'),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

const createConfig = async function (
  anchorProgram: anchor.Program,
  payerWallet: anchor.web3.Keypair,
  configData: {
    maxNumberOfLines: BN;
    symbol: string;
    sellerFeeBasisPoints: number;
    isMutable: boolean;
    maxSupply: BN;
    retainAuthority: boolean;
    creators: {
      address: anchor.web3.PublicKey;
      verified: boolean;
      share: number;
    }[];
  },
) {
  const size =
    configArrayStart +
    4 +
    configData.maxNumberOfLines.toNumber() * configLineSize +
    4 +
    Math.ceil(configData.maxNumberOfLines.toNumber() / 8);

  const config = anchor.web3.Keypair.generate();
  const uuid = config.publicKey.toBase58().slice(0, 6);

  return {
    config: config.publicKey,
    uuid,
    txId: await anchorProgram.rpc.initializeConfig(
      {
        uuid,
        ...configData,
      },
      {
        accounts: {
          config: config.publicKey,
          authority: payerWallet.publicKey,
          payer: payerWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [payerWallet, config],
        instructions: [
          anchor.web3.SystemProgram.createAccount({
            fromPubkey: payerWallet.publicKey,
            newAccountPubkey: config.publicKey,
            space: size,
            lamports:
              await anchorProgram.provider.connection.getMinimumBalanceForRentExemption(
                size,
              ),
            programId: programId,
          }),
        ],
      },
    ),
  };
};

const sharedOptionsCommand = function (name) {
  return program
    .createCommand(name)
    .option('-u, --url <url>', 'Solana cluster url', DEFAULT_CLUSTER_URL)
    .option('-k, --keypair <path>', 'Solana wallet')
    .option('-c, --cache-name <path>', 'Cache file name', DEFAULT_CACHE_NAME);
};

const upload = sharedOptionsCommand('upload')
  .argument(
    '<directory>',
    'Directory containing images named from 0-n',
    val => {
      return fs.readdirSync(`${val}`).map(file => path.join(val, file));
    },
  )
  // .argument('[second]', 'integer argument', (val) => parseInt(val), 1000)
  .option('-s, --start-with', 'Image index to start with', '0')
  .option('-n, --number', 'Number of images to upload', '10000')
  .action(async (files: string[], options, cmd) => {
    const extension = '.png';
    const { keypair, cacheName, url } = cmd.opts();

    let env: string; // default same as url default

    switch (url) {
      case MAINNET_CLUSTER_URL:
        env = 'mainnet';
      case TESTNET_CLUSTER_URL:
        env = 'testnet';
      case DEVNET_CLUSTER_URL:
        env = 'devnet';
    }

    const cachePath = path.join(CACHE_PATH, cacheName);
    const savedContent = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath).toString())
      : undefined;
    const cacheContent = savedContent || {};

    if (!cacheContent.program) {
      cacheContent.program = {};
    }

    let existingInCache = [];
    if (!cacheContent.items) {
      cacheContent.items = {};
    } else {
      existingInCache = Object.keys(cacheContent.items);
    }

    const seen = {};
    const newFiles = [];

    files.forEach(f => {
      if (!seen[f.replace(extension, '').split('/').pop()]) {
        seen[f.replace(extension, '').split('/').pop()] = true;
        newFiles.push(f);
      }
    });
    existingInCache.forEach(f => {
      if (!seen[f]) {
        seen[f] = true;
        newFiles.push(f + '.png');
      }
    });

    const images = newFiles.filter(val => path.extname(val) === extension);
    const SIZE = images.length; // images.length;
    const walletKey = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString())),
    );

    // const conversionRates = JSON.parse(
    //   await (
    //     await fetch(
    //       'https://api.coingecko.com/api/v3/simple/price?ids=solana,arweave&vs_currencies=usd',
    //     )
    //   ).text(),
    // );
    // const baseCost = fetch(``);
    // const increment = fetch(``);

    const solConnection = new anchor.web3.Connection(url);

    const walletWrapper = new anchor.Wallet(walletKey);
    const provider = new anchor.Provider(solConnection, walletWrapper, {
      preflightCommitment: 'recent',
    });
    const idl = await anchor.Program.fetchIdl(programId, provider);
    const anchorProgram = new anchor.Program(idl, programId, provider);
    let config = cacheContent.program.config
      ? new anchor.web3.PublicKey(cacheContent.program.config)
      : undefined;

    await solConnection.getRecentBlockhash();
    for (let i = 0; i < SIZE; i++) {
      const image = images[i];
      const imageName = path.basename(image);
      const index = imageName.replace(extension, '');

      console.log(`Processing file: ${index}`);

      const storageCost = 10;

      let link = cacheContent?.items?.[index]?.link;
      if (!link || !cacheContent.program.uuid) {
        const imageBuffer = Buffer.from(fs.readFileSync(image));
        const manifestPath = image.replace(extension, '.json');
        const manifestContent = fs
          .readFileSync(manifestPath)
          .toString()
          .replace(imageName, 'image.png')
          .replace(imageName, 'image.png');
        const manifest = JSON.parse(manifestContent);

        const manifestBuffer = Buffer.from(JSON.stringify(manifest));

        if (i === 0 && !cacheContent.program.uuid) {
          // initialize config
          try {
            const res = await createConfig(anchorProgram, walletKey, {
              maxNumberOfLines: new BN(SIZE),
              symbol: manifest.symbol,
              sellerFeeBasisPoints: manifest.seller_fee_basis_points,
              isMutable: true,
              maxSupply: new BN(0),
              retainAuthority: true,
              creators: manifest.properties.creators.map(creator => {
                return {
                  address: new anchor.web3.PublicKey(creator.address),
                  verified: false,
                  share: creator.share,
                };
              }),
            });
            cacheContent.program.uuid = res.uuid;
            cacheContent.program.config = res.config.toBase58();
            config = res.config;

            fs.writeFileSync(
              path.join(CACHE_PATH, cacheName),
              JSON.stringify(cacheContent),
            );
          } catch (exx) {
            console.error('Error deploying config to Solana network.', exx);
            // console.error(exx);
          }
        }

        if (!link) {
          let instructions = [
            anchor.web3.SystemProgram.transfer({
              fromPubkey: walletKey.publicKey,
              toPubkey: PAYMENT_WALLET,
              lamports: storageCost,
            }),
          ];

          const tx = await sendTransactionWithRetryWithKeypair(
            solConnection,
            walletKey,
            instructions,
            [],
            'single',
          );
          console.info('transaction for arweave payment:', tx);

          // data.append('tags', JSON.stringify(tags));
          // payment transaction
          const data = new FormData();
          data.append('transaction', tx['txid']);
          data.append('env', env);
          data.append('file[]', fs.createReadStream(image), `image.png`);
          data.append('file[]', manifestBuffer, 'metadata.json');
          try {
            const result = await (
              await fetch(
                'https://us-central1-principal-lane-200702.cloudfunctions.net/uploadFile3',
                {
                  method: 'POST',
                  body: data,
                },
              )
            ).json();

            const metadataFile = result.messages?.find(
              m => m.filename === 'manifest.json',
            );
            if (metadataFile?.transactionId) {
              link = `https://arweave.net/${metadataFile.transactionId}`;
              console.log(`File uploaded: ${link}`);
            }

            cacheContent.items[index] = {
              link,
              name: manifest.name,
              onChain: false,
            };
            fs.writeFileSync(
              path.join(CACHE_PATH, cacheName),
              JSON.stringify(cacheContent),
            );
          } catch (er) {
            console.error(`Error uploading file ${index}`, er);
          }
        }
      }
    }

    const keys = Object.keys(cacheContent.items);
    try {
      await Promise.all(
        chunks(Array.from(Array(keys.length).keys()), 1000).map(
          async allIndexesInSlice => {
            for (
              let offset = 0;
              offset < allIndexesInSlice.length;
              offset += 10
            ) {
              const indexes = allIndexesInSlice.slice(offset, offset + 10);
              const onChain = indexes.filter(i => {
                const index = keys[i];
                return cacheContent.items[index]?.onChain;
              });
              const ind = keys[indexes[0]];

              if (onChain.length != indexes.length) {
                console.log(
                  'Writing indices ',
                  ind,
                  '-',
                  keys[indexes[indexes.length - 1]],
                );
                const txId = await anchorProgram.rpc.addConfigLines(
                  ind,
                  indexes.map(i => ({
                    uri: cacheContent.items[keys[i]].link,
                    name: cacheContent.items[keys[i]].name,
                  })),
                  {
                    accounts: {
                      config,
                      authority: walletKey.publicKey,
                    },
                    signers: [walletKey],
                  },
                );
                indexes.forEach(i => {
                  cacheContent.items[keys[i]] = {
                    ...cacheContent.items[keys[i]],
                    onChain: true,
                  };
                });
                fs.writeFileSync(
                  path.join(CACHE_PATH, cacheName),
                  JSON.stringify(cacheContent),
                );
              }
            }
          },
        ),
      );
    } catch (e) {
      console.error(e);
    } finally {
      fs.writeFileSync(
        path.join(CACHE_PATH, cacheName),
        JSON.stringify(cacheContent),
      );
    }
    console.log('Done');
    // TODO: start candy machine
  });

const setStartDate = sharedOptionsCommand('set_start_date')
  .option('-d, --date <string>', 'timestamp - eg "04 Dec 1995 00:12:00 GMT"')
  .action(async (directory, cmd) => {
    const { keypair, url, cacheName } = cmd.opts();
    const solConnection = new anchor.web3.Connection(url);

    const cachePath = path.join(CACHE_PATH, cacheName);
    const cachedContent = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath).toString())
      : undefined;

    const date = cmd.getOptionValue('date');
    const secondsSinceEpoch = (date ? Date.parse(date) : Date.now()) / 1000;
    const walletKey = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString())),
    );
    const walletWrapper = new anchor.Wallet(walletKey);
    const provider = new anchor.Provider(solConnection, walletWrapper, {
      preflightCommitment: 'recent',
    });
    const idl = await anchor.Program.fetchIdl(programId, provider);
    const anchorProgram = new anchor.Program(idl, programId, provider);
    const [candyMachine, _] = await getCandyMachine(
      new anchor.web3.PublicKey(cachedContent.program.config),
      cachedContent.program.uuid,
    );
    const tx = await anchorProgram.rpc.updateCandyMachine(
      null,
      new anchor.BN(secondsSinceEpoch),
      {
        accounts: {
          candyMachine,
          authority: walletKey.publicKey,
        },
      },
    );

    console.log('Done', secondsSinceEpoch, tx);
  });

const createCandyMachine = sharedOptionsCommand('create_candy_machine')
  .option('-p, --price <string>', 'SOL price', '1')
  .action(async (directory, cmd) => {
    const { keypair, url, cacheName, price } = cmd.opts();

    const solConnection = new anchor.web3.Connection(url);

    const lamports = parseInt(price) * LAMPORTS_PER_SOL;
    const cachePath = path.join(CACHE_PATH, cacheName);
    const cachedContent = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath).toString())
      : undefined;

    const walletKey = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString())),
    );
    const walletWrapper = new anchor.Wallet(walletKey);
    const provider = new anchor.Provider(solConnection, walletWrapper, {
      preflightCommitment: 'recent',
    });
    const idl = await anchor.Program.fetchIdl(programId, provider);
    const anchorProgram = new anchor.Program(idl, programId, provider);
    const config = new anchor.web3.PublicKey(cachedContent.program.config);
    const [candyMachine, bump] = await getCandyMachine(
      config,
      cachedContent.program.uuid,
    );
    await anchorProgram.rpc.initializeCandyMachine(
      bump,
      {
        uuid: cachedContent.program.uuid,
        price: new anchor.BN(lamports),
        itemsAvailable: new anchor.BN(Object.keys(cachedContent.items).length),
        goLiveDate: null,
      },
      {
        accounts: {
          candyMachine,
          wallet: walletKey.publicKey,
          config: config,
          authority: walletKey.publicKey,
          payer: walletKey.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [],
      },
    );

    console.log(`Done: CANDYMACHINE: ${candyMachine.toBase58()}`);
  });

const mintOneToken = sharedOptionsCommand('mint_one_token').action(
  async (directory, cmd) => {
    const { keypair, url, cacheName, price } = cmd.opts();

    const solConnection = new anchor.web3.Connection(url);

    const lamports = parseInt(price) * LAMPORTS_PER_SOL;

    const cachePath = path.join(CACHE_PATH, cacheName);
    const cachedContent = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath).toString())
      : undefined;
    const mint = anchor.web3.Keypair.generate();

    const walletKey = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString())),
    );
    const token = await getTokenWallet(walletKey.publicKey, mint.publicKey);
    const walletWrapper = new anchor.Wallet(walletKey);
    const provider = new anchor.Provider(solConnection, walletWrapper, {
      preflightCommitment: 'recent',
    });
    const idl = await anchor.Program.fetchIdl(programId, provider);
    const anchorProgram = new anchor.Program(idl, programId, provider);
    const config = new anchor.web3.PublicKey(cachedContent.program.config);
    const [candyMachine, bump] = await getCandyMachine(
      config,
      cachedContent.program.uuid,
    );
    const candy = await anchorProgram.account.candyMachine.fetch(candyMachine);
    const metadata = await getMetadata(mint.publicKey);
    const masterEdition = await getMasterEdition(mint.publicKey);
    const tx = await anchorProgram.rpc.mintNft({
      accounts: {
        config: config,
        candyMachine: candyMachine,
        payer: walletKey.publicKey,
        //@ts-ignore
        wallet: candy.wallet,
        mint: mint.publicKey,
        metadata,
        masterEdition,
        mintAuthority: walletKey.publicKey,
        updateAuthority: walletKey.publicKey,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
      signers: [mint, walletKey],
      instructions: [
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: walletKey.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MintLayout.span,
          lamports: await provider.connection.getMinimumBalanceForRentExemption(
            MintLayout.span,
          ),
          programId: TOKEN_PROGRAM_ID,
        }),
        Token.createInitMintInstruction(
          TOKEN_PROGRAM_ID,
          mint.publicKey,
          0,
          walletKey.publicKey,
          walletKey.publicKey,
        ),
        createAssociatedTokenAccountInstruction(
          token,
          walletKey.publicKey,
          walletKey.publicKey,
          mint.publicKey,
        ),
        Token.createMintToInstruction(
          TOKEN_PROGRAM_ID,
          mint.publicKey,
          token,
          walletKey.publicKey,
          [],
          1,
        ),
      ],
    });

    console.log('Done', tx);
  },
);

program
  .command('verify')
  .option('-u, --url', 'Solana cluster url', DEFAULT_CLUSTER_URL)
  .option('-c, --cache-name <path>', 'Cache file name', DEFAULT_CACHE_NAME)
  .action(async (directory, second, options, cmd) => {
    const solConnection = new anchor.web3.Connection(options.url);
    const { cacheName } = cmd.opts();
    const cachePath = path.join(CACHE_PATH, cacheName);
    const cachedContent = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath).toString())
      : undefined;

    const config = await solConnection.getAccountInfo(
      new PublicKey(cachedContent.program.config),
    );
    const number = new BN(config.data.slice(247, 247 + 4), undefined, 'le');
    console.log('Number', number.toNumber());

    const keys = Object.keys(cachedContent.items);
    for (let i = 0; i < keys.length; i++) {
      console.log('Looking at key ', i);
      const key = keys[i];
      const thisSlice = config.data.slice(
        configArrayStart + 4 + configLineSize * i,
        configArrayStart + 4 + configLineSize * (i + 1),
      );
      const name = fromUTF8Array([...thisSlice.slice(4, 36)]);
      const uri = fromUTF8Array([...thisSlice.slice(40, 240)]);
      const cacheItem = cachedContent.items[key];
      if (!name.match(cacheItem.name) || !uri.match(cacheItem.link)) {
        console.log(
          'Name',
          name,
          'or uri',
          uri,
          'didnt match cache values of',
          cacheItem.name,
          'and',
          cacheItem.link,
          ' marking to rerun for image',
          key,
        );
        cacheItem.onChain = false;
      } else {
        console.log('Name', name, 'with', uri, 'checked out');
      }
    }
    fs.writeFileSync(
      path.join(CACHE_PATH, cacheName),
      JSON.stringify(cachedContent),
    );
  });

program.command('find-wallets').action(() => {});

program
  .addCommand(upload)
  .addCommand(createCandyMachine)
  .addCommand(setStartDate)
  .addCommand(mintOneToken);

program.parse(process.argv);
