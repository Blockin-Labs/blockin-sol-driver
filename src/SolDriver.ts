import { Balance, BigIntify, NumberType, UintRange, convertBalance, convertUintRange } from "bitbadgesjs-proto"
import { GetBadgeBalanceByAddressRoute, GetBadgeBalanceByAddressRouteSuccessResponse, OffChainBalancesMap, convertToCosmosAddress, getBalancesForIds } from "bitbadgesjs-utils"
import { IChainDriver, constructChallengeObjectFromString } from "blockin"
import { AndGroup, AssetConditionGroup, OrGroup, OwnershipRequirements, convertAssetConditionGroup } from "blockin/dist/types/verify.types"
import bs58 from "bs58"
import nacl from "tweetnacl"

import axiosApi from 'axios';

export const axios = axiosApi.create({
  withCredentials: true,
  headers: {
    "Content-type": "application/json",
  },
});

/**
 * Ethereum implementation of the IChainDriver interface. This implementation is based off the Moralis API
 * and ethers.js library.
 *
 * For documentation regarding what each function does, see the IChainDriver interface.
 *
 * Note that the Blockin library also has many convenient, chain-generic functions that implement
 * this logic for creating / verifying challenges. Before using, you will have to setChainDriver(new EthDriver(.....)) first.
 */
export default class SolDriver implements IChainDriver<bigint> {
  chain
  constructor(chain: string) {
    this.chain = chain
  }

  async parseChallengeStringFromBytesToSign(txnBytes: Uint8Array) {
    return new TextDecoder().decode(txnBytes)
  }


  isValidAddress(address: string) {
    return address.length === 44
  }


  async verifySignature(message: string, signature: string) {
    const originalAddress = constructChallengeObjectFromString(message, JSON.stringify).address
    const solanaPublicKeyBase58 = originalAddress;

    const originalBytes = new Uint8Array(Buffer.from(message, 'utf8'));
    const signatureBytes = new Uint8Array(Buffer.from(signature, 'hex'));

    // Decode the base58 Solana public key
    const solanaPublicKeyBuffer = bs58.decode(solanaPublicKeyBase58);
    const verified = nacl.sign.detached.verify(
      originalBytes,
      signatureBytes,
      solanaPublicKeyBuffer
    )

    if (!verified) {
      throw `Signature Invalid`
    }
  }


  async verifyAssets(address: string, resources: string[], _assets: AssetConditionGroup<NumberType> | undefined, balancesSnapshot?: object): Promise<any> {
    const andItem: AndGroup<bigint> = _assets as AndGroup<bigint>
    const orItem: OrGroup<bigint> = _assets as OrGroup<bigint>
    const normalItem: OwnershipRequirements<bigint> = _assets as OwnershipRequirements<bigint>

    if (andItem.$and) {
      for (const item of andItem.$and) {
        await this.verifyAssets(address, resources, item, balancesSnapshot)
      }
    } else if (orItem.$or) {
      for (const item of orItem.$or) {
        try {
          await this.verifyAssets(address, resources, item, balancesSnapshot)
          return  //if we get here, we are good (short circuit)
        } catch (e) {
          continue
        }
      }

      throw new Error(`Did not meet the requirements for any of the assets in the group`)
    } else {
      const numToSatisfy = normalItem.options?.numMatchesForVerification ?? 0;
      const mustSatisfyAll = !numToSatisfy;

      let numSatisfied = 0;
      for (const asset of normalItem.assets) {


        let docBalances: Balance<bigint>[] = []
        let balances: Balance<bigint>[] = [];

        if (asset.chain === 'BitBadges') {
          if (!balancesSnapshot) {
            const balancesRes: GetBadgeBalanceByAddressRouteSuccessResponse<string> = await axios.post(
              "https://api.bitbadges.io" +
              GetBadgeBalanceByAddressRoute(asset.collectionId, convertToCosmosAddress(address),),
              {},
              {
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": process.env.BITBADGES_API_KEY,
                },
              },
            ).then((res) => {
              return res.data
            })

            docBalances = balancesRes.balance.balances.map((x) => convertBalance(x, BigIntify))
          } else {
            const cosmosAddress = convertToCosmosAddress(address)
            const balancesSnapshotObj = balancesSnapshot as OffChainBalancesMap<bigint>
            docBalances = balancesSnapshotObj[cosmosAddress] ? balancesSnapshotObj[cosmosAddress].map(x => convertBalance(x, BigIntify)) : []
          }


          if (asset.collectionId === 'BitBadges Lists') {
            throw new Error(`BitBadges Lists are not supported for now`)
          } else {
            if (
              !asset.assetIds.every(
                (x) => typeof x === "object" && BigInt(x.start) >= 0 && BigInt(x.end) >= 0,
              )
            ) {
              throw new Error(`All assetIds must be UintRanges for BitBadges compatibility`)
            }
          }

          if (
            asset.ownershipTimes &&
            !asset.ownershipTimes.every(
              (x) => typeof x === "object" && BigInt(x.start) >= 0 && BigInt(x.end) >= 0,
            )
          ) {
            throw new Error(`All ownershipTimes must be UintRanges for BitBadges compatibility`)
          }

          if (
            asset.mustOwnAmounts && !(typeof asset.mustOwnAmounts === "object" && BigInt(asset.mustOwnAmounts.start) >= 0 && BigInt(asset.mustOwnAmounts.end) >= 0)
          ) {
            throw new Error(`mustOwnAmount must be UintRange for BitBadges compatibility`)
          }

          if (!asset.ownershipTimes || asset.ownershipTimes.length === 0) {
            asset.ownershipTimes = [{ start: BigInt(Date.now()), end: BigInt(Date.now()) }]
          }

          balances = getBalancesForIds(
            asset.assetIds.map((x) => convertUintRange(x as UintRange<bigint>, BigIntify)),
            asset.ownershipTimes.map((x) => convertUintRange(x, BigIntify)),
            docBalances,
          )

        } else {
          //TODO: Add Solana asset verification

          throw new Error(`Solana asset verification is not supported for now`)
        }

        const mustOwnAmount = asset.mustOwnAmounts

        for (const balance of balances) {
          if (balance.amount < mustOwnAmount.start) {
            if (mustSatisfyAll) {
              if (asset.collectionId === 'BitBadges Lists') {
                const listIdIdx = balance.badgeIds[0].start - 1n;
                const correspondingListId = asset.assetIds[Number(listIdIdx)]
                throw new Error(
                  `Address ${address} does not meet the requirements for list ${correspondingListId}`,
                )
              } else {
                throw new Error(
                  `Address ${address} does not own enough of IDs ${balance.badgeIds
                    .map((x) => `${x.start}-${x.end}`)
                    .join(",")} from collection ${asset.collectionId
                  } to meet minimum balance requirement of ${mustOwnAmount.start}`,
                )
              }
            } else {
              continue
            }
          }

          if (balance.amount > mustOwnAmount.end) {
            if (mustSatisfyAll) {
              if (asset.collectionId === 'BitBadges Lists') {
                const listIdIdx = balance.badgeIds[0].start - 1n;
                const correspondingListId = asset.assetIds[Number(listIdIdx)]
                throw new Error(
                  `Address ${address} does not meet requirements for list ${correspondingListId}`,
                )
              }
              else {
                throw new Error(
                  `Address ${address} owns too much of IDs ${balance.badgeIds
                    .map((x) => `${x.start}-${x.end}`)
                    .join(",")} from collection ${asset.collectionId
                  } to meet maximum balance requirement of ${mustOwnAmount.end}`,
                )
              }
            } else {
              continue
            }
          }

          numSatisfied++;
        }
      }

      if (mustSatisfyAll) {
        //we made it through all balances and didn't throw an error so we are good
      } else if (numSatisfied < numToSatisfy) {
        throw new Error(
          `Address ${address} did not meet the ownership requirements for at least ${numToSatisfy} of the IDs. Met for ${numSatisfied} of the IDs.`,
        )
      }
    }

  }
}
